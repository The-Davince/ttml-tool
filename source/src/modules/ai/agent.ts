import {
        type AISettings,
        type AIStep,
        type AITurn,
        aiRunningAtom,
        aiTurnsAtom,
        nextAIStepId,
        nextAITurnId,
} from "$/modules/ai/states";
import { getAgentTool, getToolSchemas } from "$/modules/ai/tools";
import { lyricLinesAtom } from "$/states/main.ts";
import { globalStore } from "$/states/store.ts";

/**
 * Agent 循环
 *
 * 用户输入 → LLM 思考 → 工具调用 → 结果回传 → 继续思考 → … → 最终回答
 * 每一步实时写入 aiTurnsAtom，UI 同步展示执行进度。
 */

const MAX_TOOL_ROUNDS = 12;

interface LLMMessage {
        role: "system" | "user" | "assistant" | "tool";
        content?: string;
        tool_calls?: Array<{
                id: string;
                type: "function";
                function: { name: string; arguments: string };
        }>;
        tool_call_id?: string;
}

/** LLM 会话记忆（含工具交互），清空聊天时重置 */
let llmMessages: LLMMessage[] = [];

export const resetAgentMemory = () => {
        llmMessages = [];
};

let abortController: AbortController | null = null;

export const abortAgentRun = () => {
        abortController?.abort();
};

const buildSystemPrompt = (): string => {
        const lyric = globalStore.get(lyricLinesAtom);
        const meta: Record<string, string> = {};
        for (const m of lyric.metadata) {
                if (m.value.length > 0 && !meta[m.key]) meta[m.key] = m.value.join("/");
        }
        const title =
                meta.musicName ?? meta["dc:title"] ?? meta.title ?? "未知";
        const artist =
                meta.artists ?? meta["ttm:artist"] ?? meta["music-artist"] ?? meta.artist ??
                "未知";
        return `你是 AMLL TTML Tool 内置的歌词制作 AI 助手，可以搜索互联网、搜索 QQ 音乐曲库，并直接操作歌词编辑器。

当前文档：${title} - ${artist}，共 ${lyric.lyricLines.length} 行歌词。

# 可用工具
你可以调用工具完成实际操作（类似 MCP）。工具清单由系统自动注入。

# 核心规则
1. 行号、音节序号一律从 0 开始计数。
2. 对歌词的任何修改必须通过工具调用完成，不要只是口头描述。
3. 不确定当前歌词结构时，先调用 get_lyrics_info 查看。
4. 假名标注：为汉字词提供正确的日语读音，kana 数组中每个元素是一个读音单元（拗音如「きゃ」「しゅ」算一个单元），使用平假名。多个音节用 batch_set_ruby 批量处理更高效。
5. 罗马音：优先调用 auto_romaji 从假名自动转换；汉字没有假名时先标注假名再转换。
6. 查歌曲信息/歌词原文/读音资料用 search_web；需要网页详细内容时用 read_page。
7. QQ 音乐工具（优先推荐）：search_qq_music 搜歌（关键词只用歌名或只用歌手名，不要拼在一起），import_qq_lyric 用 songMid 一键导入官方逐字歌词（高保真：逐字时间轴/逐假名注音/逐词罗马音/翻译）。用户想找某首歌的歌词、或想快速铺时间轴时优先走这条链路。
8. 一次可以发起多个工具调用，复杂任务分步执行。
9. 完成修改后，简要总结做了什么。使用简体中文回复，简洁友好，不要输出 Markdown 标题。`;
};

/**
 * 通道探测缓存：
 *   null = 尚未探测；true = 该 baseURL 可浏览器直连；false = 直连被 CORS/网络拦截，走后端代理。
 * 一旦确认，同一次会话内后续请求沿用，避免每轮都先撞一次失败的直连。
 */
let directChannelOk: boolean | null = null;
let probedBaseURL = "";

/** baseURL 变化时重置探测（在 runAgentTurn 开头调用） */
export const resetAIChannelProbe = (baseURL: string) => {
        if (probedBaseURL !== baseURL) {
                directChannelOk = null;
                probedBaseURL = baseURL;
        }
};

/** 由 baseURL 推导 chat/completions 端点（与 server.py 逻辑保持一致） */
const buildChatEndpoint = (baseURL: string): string => {
        const b = baseURL.trim().replace(/\/+$/, "");
        return b.endsWith("/chat/completions") ? b : `${b}/chat/completions`;
};

/** 解析 OpenAI 兼容响应，取出 choices[0].message */
const pickMessage = (data: unknown): LLMMessage => {
        const choices = (data as { choices?: Array<{ message?: LLMMessage }> })
                .choices;
        const message = choices?.[0]?.message;
        if (!message) throw new Error("AI 接口响应中缺少 choices[0].message");
        return message;
};

const chatCompletion = async (
        settings: AISettings,
        messages: LLMMessage[],
        signal: AbortSignal,
): Promise<{ message: LLMMessage }> => {
        const tools = getToolSchemas();
        resetAIChannelProbe(settings.baseURL);

        /** 通道一：浏览器直连 OpenAI 兼容端点 */
        const tryDirect = async (): Promise<{ message: LLMMessage }> => {
                const resp = await fetch(buildChatEndpoint(settings.baseURL), {
                        method: "POST",
                        headers: {
                                "Content-Type": "application/json",
                                ...(settings.apiKey
                                        ? { Authorization: `Bearer ${settings.apiKey}` }
                                        : {}),
                        },
                        body: JSON.stringify({
                                model: settings.model,
                                temperature: settings.temperature,
                                stream: false,
                                messages,
                                ...(tools.length
                                        ? { tools, tool_choice: "auto" }
                                        : {}),
                        }),
                        signal,
                });
                // fetch 未抛错 = 传输层与 CORS 均正常，缓存“可直连”
                directChannelOk = true;
                let data: unknown;
                try {
                        data = await resp.json();
                } catch {
                        throw new Error(`AI 接口返回了非 JSON 内容（HTTP ${resp.status}）`);
                }
                if (!resp.ok) {
                        throw new Error(
                                (data as { error?: string })?.error ??
                                        `AI 接口请求失败（HTTP ${resp.status}）`,
                        );
                }
                return { message: pickMessage(data) };
        };

        /** 通道二：本地后端代理 server.py /api/ai/chat */
        const tryProxy = async (): Promise<{ message: LLMMessage }> => {
                const resp = await fetch("/api/ai/chat", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                                baseURL: settings.baseURL,
                                apiKey: settings.apiKey,
                                model: settings.model,
                                temperature: settings.temperature,
                                messages,
                                tools,
                        }),
                        signal,
                });
                let data: unknown;
                try {
                        data = await resp.json();
                } catch {
                        throw new Error(`AI 接口返回了非 JSON 内容（HTTP ${resp.status}）`);
                }
                if (!resp.ok) {
                        throw new Error(
                                (data as { error?: string })?.error ??
                                        `AI 接口请求失败（HTTP ${resp.status}）`,
                        );
                }
                return { message: pickMessage(data) };
        };

        // 已确认需要走代理，或尚未配置可直连的 baseURL → 直接代理
        if (directChannelOk === false || !settings.baseURL.trim()) {
                return tryProxy();
        }

        try {
                return await tryDirect();
        } catch (e) {
                // 用户主动停止：原样抛出，交由上层处理中断
                if (signal.aborted) throw e;
                // 仅“传输层失败”（CORS / 网络不可达，浏览器抛 TypeError）才回落代理；
                // tryDirect 内部因 HTTP 非 2xx / 非 JSON / 缺 message 抛出的 Error 不再重复请求。
                if (e instanceof TypeError) {
                        directChannelOk = false;
                        return tryProxy();
                }
                throw e;
        }
};

/** 更新当前轮次（不可变更新，保持 atom 引用变化） */
const updateTurn = (turnId: string, updater: (turn: AITurn) => AITurn) => {
        globalStore.set(aiTurnsAtom, (turns) =>
                turns.map((t) => (t.id === turnId ? updater(t) : t)),
        );
};

const appendStep = (turnId: string, step: AIStep) => {
        updateTurn(turnId, (turn) => ({ ...turn, steps: [...turn.steps, step] }));
        return step.id;
};

const updateStep = (turnId: string, stepId: string, patch: Partial<AIStep>) => {
        updateTurn(turnId, (turn) => ({
                ...turn,
                steps: turn.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
        }));
};

const TOOL_LABELS: Record<string, string> = {
        get_lyrics_info: "读取歌词结构",
        search_web: "搜索网页",
        search_qq_music: "搜索 QQ 音乐",
        import_qq_lyric: "导入 QQ 歌词",
        read_page: "阅读网页",
        merge_lines: "合并歌词行",
        merge_syllables: "合并音节",
        delete_lines: "删除歌词行",
        insert_line: "插入歌词行",
        replace_word_text: "修改音节文本",
        set_word_ruby: "标注假名",
        batch_set_ruby: "批量标注假名",
        auto_romaji: "生成罗马音",
        set_line_roman: "设置音译",
        set_line_translation: "设置翻译",
        set_metadata: "设置元数据",
};

export const getToolLabel = (name: string) => TOOL_LABELS[name] ?? name;

/**
 * 兜底解析：把「写进 content 文本里的工具调用」还原成标准结构。
 *
 * 部分端点在 tool_choice=auto 下不会走原生 function calling，而是把
 * {"tool_calls":[{"name":"...","arguments":{}}]} 当作普通文字塞进 content，
 * 导致前端读不到 message.tool_calls、把这段 JSON 直接显示给用户。
 * 这里同时兼容 OpenAI 标准形态与扁平 {name, arguments} 形态。
 */
const parseTextToolCalls = (
        raw: string,
): NonNullable<LLMMessage["tool_calls"]> => {
        const text = raw.trim();
        if (!text || !(text.includes("tool_calls") || text.includes('"name"'))) {
                return [];
        }
        const candidates: string[] = [text];
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) candidates.push(fenced[1].trim());
        const bracket = text.match(/[[{][\s\S]*[\]}]/);
        if (bracket) candidates.push(bracket[0]);
        for (const source of candidates) {
                let parsed: unknown;
                try {
                        parsed = JSON.parse(source);
                } catch {
                        continue;
                }
                const obj = parsed as Record<string, unknown>;
                const arr = Array.isArray(parsed)
                        ? parsed
                        : Array.isArray(obj?.tool_calls)
                                ? (obj.tool_calls as unknown[])
                                : null;
                if (!arr?.length) continue;
                const calls: NonNullable<LLMMessage["tool_calls"]> = [];
                arr.forEach((item, i) => {
                        const it = (item ?? {}) as Record<string, unknown>;
                        const fn = (it.function ?? it) as Record<string, unknown>;
                        const name =
                                typeof fn.name === "string"
                                        ? fn.name
                                        : typeof it.name === "string"
                                                ? it.name
                                                : "";
                        if (!name) return;
                        const rawArgs = fn.arguments ?? it.arguments;
                        const argsStr =
                                typeof rawArgs === "string"
                                        ? rawArgs
                                        : rawArgs && typeof rawArgs === "object"
                                                ? JSON.stringify(rawArgs)
                                                : "{}";
                        calls.push({
                                id:
                                        typeof it.id === "string" && it.id
                                                ? it.id
                                                : `call_text_${Date.now()}_${i}`,
                                type: "function",
                                function: { name, arguments: argsStr },
                        });
                });
                if (calls.length) return calls;
        }
        return [];
};

/** 优先用标准 message.tool_calls，为空时回退解析 content 文本 */
const extractToolCalls = (
        message: LLMMessage,
): NonNullable<LLMMessage["tool_calls"]> => {
        if (message.tool_calls?.length) return message.tool_calls;
        return parseTextToolCalls(message.content ?? "");
};

/** 执行一轮 Agent 对话，返回是否成功结束 */
export async function runAgentTurn(
        settings: AISettings,
        userText: string,
): Promise<void> {
        const turn: AITurn = {
                id: nextAITurnId(),
                userText,
                steps: [],
                status: "running",
                time: Date.now(),
        };
        globalStore.set(aiTurnsAtom, (turns) => [...turns, turn]);
        globalStore.set(aiRunningAtom, true);
        abortController = new AbortController();
        const controller = abortController;

        llmMessages.push({ role: "user", content: userText });
        // 控制上下文长度：只保留最近 40 条
        if (llmMessages.length > 40) {
                llmMessages = llmMessages.slice(-40);
        }

        const finish = (patch: Partial<AITurn>) => {
                updateTurn(turn.id, (t) => ({
                        ...t,
                        ...patch,
                        status: patch.status ?? t.status,
                }));
                globalStore.set(aiRunningAtom, false);
                abortController = null;
        };

        try {
                for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                        const thinkStepId = appendStep(turn.id, {
                                id: nextAIStepId(),
                                kind: "thinking",
                                title: round === 0 ? "AI 正在思考…" : "结合工具结果继续思考…",
                                status: "running",
                        });
                        const thinkStart = performance.now();
                        const { message } = await chatCompletion(
                                settings,
                                [{ role: "system", content: buildSystemPrompt() }, ...llmMessages],
                                controller.signal,
                        );
                        updateStep(turn.id, thinkStepId, {
                                status: "done",
                                durationMs: Math.round(performance.now() - thinkStart),
                        });

                        const toolCalls = extractToolCalls(message);
                        if (toolCalls.length > 0) {
                                // 兜底解析出的文本调用不保留进正文，避免污染会话历史
                                const assistantText = message.tool_calls?.length
                                        ? (message.content ?? "")
                                        : "";
                                llmMessages.push({
                                        role: "assistant",
                                        content: assistantText,
                                        tool_calls: toolCalls,
                                });
                                for (const tc of toolCalls) {
                                        let args: Record<string, unknown> = {};
                                        let argsJson = "";
                                        try {
                                                argsJson = tc.function.arguments || "{}";
                                                args = JSON.parse(argsJson) as Record<string, unknown>;
                                        } catch {
                                                argsJson = tc.function.arguments ?? "";
                                        }
                                        const stepId = appendStep(turn.id, {
                                                id: nextAIStepId(),
                                                kind: "tool",
                                                title: `${getToolLabel(tc.function.name)}`,
                                                toolName: tc.function.name,
                                                argsJson:
                                                        argsJson.length > 300 ? `${argsJson.slice(0, 300)}…` : argsJson,
                                                status: "running",
                                        });
                                        const toolStart = performance.now();
                                        let resultJson: string;
                                        try {
                                                const tool = getAgentTool(tc.function.name);
                                                if (!tool) throw new Error(`未知工具：${tc.function.name}`);
                                                const result = await tool.execute(args);
                                                resultJson = JSON.stringify(result);
                                                updateStep(turn.id, stepId, {
                                                        status: result.success ? "done" : "error",
                                                        detail: result.message,
                                                        resultJson:
                                                                resultJson.length > 800
                                                                        ? `${resultJson.slice(0, 800)}…`
                                                                        : resultJson,
                                                        durationMs: Math.round(performance.now() - toolStart),
                                                });
                                        } catch (e) {
                                                resultJson = JSON.stringify({ success: false, message: String(e) });
                                                updateStep(turn.id, stepId, {
                                                        status: "error",
                                                        detail: `执行出错：${String(e)}`,
                                                        durationMs: Math.round(performance.now() - toolStart),
                                                });
                                        }
                                        llmMessages.push({
                                                role: "tool",
                                                tool_call_id: tc.id,
                                                content: resultJson,
                                        });
                                }
                                continue;
                        }

                        // 最终回答
                        const answer = (message.content ?? "").trim();
                        llmMessages.push({ role: "assistant", content: answer });
                        finish({ status: "done", answer });
                        return;
                }
                finish({
                        status: "error",
                        error: `已达到最大工具调用轮数（${MAX_TOOL_ROUNDS}），请继续对话让 AI 完成`,
                });
        } catch (e) {
                if (controller.signal.aborted) {
                        appendStep(turn.id, {
                                id: nextAIStepId(),
                                kind: "abort",
                                title: "已手动停止",
                                status: "error",
                        });
                        finish({ status: "aborted" });
                        // 移除最后一条未完成的 user 消息避免污染记忆
                        if (llmMessages[llmMessages.length - 1]?.role === "user")
                                llmMessages.pop();
                        return;
                }
                const msg = e instanceof Error ? e.message : String(e);
                appendStep(turn.id, {
                        id: nextAIStepId(),
                        kind: "error",
                        title: "出错了",
                        detail: msg,
                        status: "error",
                });
                finish({ status: "error", error: msg });
        }
}

/** 测试 AI 连通性（设置面板用） */
export async function testAIConnection(
        settings: AISettings,
): Promise<{ ok: boolean; message: string }> {
        try {
                const resp = await fetch("/api/test-ai", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                                baseURL: settings.baseURL,
                                apiKey: settings.apiKey,
                                model: settings.model,
                        }),
                });
                const data = await resp.json();
                if (!resp.ok || data.error) {
                        return {
                                ok: false,
                                message: String(data.error ?? `HTTP ${resp.status}`),
                        };
                }
                return {
                        ok: true,
                        message: `连接成功：${String(data.reply ?? "").slice(0, 50) || "模型已响应"}`,
                };
        } catch (e) {
                return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
}
