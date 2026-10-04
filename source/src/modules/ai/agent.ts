import {
        type AISettings,
        type AIStep,
        type AITurn,
        aiRunningAtom,
        aiTurnsAtom,
        apiUrl,
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
1. 【最重要】严格按用户当前请求行动，不要越权自作主张。用户只是问信息（例如“这首歌是谁唱的”“歌手生平/简介”“查一下某词的意思”）时，只用只读类工具（search_web / read_page / get_lyrics_info / search_qq_music）查证并直接回答，**绝不得擅自改动歌词文档**——不要导入/替换歌词（import_qq_lyric）、不要标注假名、不要生成罗马音（auto_romaji）。只有当用户明确要求进行制作/修改时，才动用写操作类工具。
2. 行号、音节序号一律从 0 开始计数。
3. 当确实需要修改歌词时，任何修改必须通过工具调用完成，不要只是口头描述。
4. 不确定当前歌词结构时，先调用 get_lyrics_info 查看。
5. 假名标注：为汉字词提供正确的日语读音，kana 数组中每个元素是一个读音单元（拗音如「きゃ」「しゅ」算一个单元），使用平假名。多个音节用 batch_set_ruby 批量处理更高效。
6. 罗马音：优先调用 auto_romaji 从假名自动转换；汉字没有假名时先标注假名再转换。
7. 查歌曲信息/歌词原文/读音资料用 search_web；需要网页详细内容时用 read_page。搜索务必克制、快速收敛：纯信息查询（“谁唱的”“歌手简介”“某词什么意思”）通常 1–2 次 search_web 就应足够，一旦拿到关键事实立即作答，不要为交叉验证而反复换关键词多轮搜索。若收到低相关提示，最多再简化关键词重试一次（去掉引号、只留歌名或歌手名），仍不理想就基于现有结果作答或改用 search_qq_music；切勿用同样的长查询反复重试。
8. QQ 音乐工具（优先推荐）：search_qq_music 搜歌（关键词只用歌名或只用歌手名，不要拼在一起），import_qq_lyric 用 songMid 一键导入官方逐字歌词（高保真：逐字时间轴/逐假名注音/逐词罗马音/翻译）。仅当用户想找某首歌的歌词、或想快速铺时间轴时才走这条链路。
9. 一次可以发起多个工具调用，复杂任务分步执行。
10. 完成修改后，简要总结做了什么。使用简体中文回复，简洁友好；较长的回答可用 Markdown（加粗、列表、小标题）组织，界面已支持渲染。`;
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

/** 从非 2xx 响应体里尽量提取可读错误（兼容 error / error.message / message 等形态） */
const extractErrText = (data: unknown, status: number): string => {
        const d = data as {
                error?: unknown;
                message?: unknown;
                msg?: unknown;
        };
        if (typeof d?.error === "string") return d.error;
        if (d?.error && typeof d.error === "object") {
                const m = (d.error as { message?: string }).message;
                if (m) return m;
        }
        if (typeof d?.message === "string") return d.message;
        if (typeof d?.msg === "string") return d.msg;
        return `AI 接口请求失败（HTTP ${status}）`;
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
                        throw new Error(extractErrText(data, resp.status));
                }
                return { message: pickMessage(data) };
        };

        /** 通道二：本地后端代理 server.py /api/ai/chat（带瞬态重试，更鲁棒） */
        const tryProxy = async (): Promise<{ message: LLMMessage }> => {
                const resp = await fetch(apiUrl("/api/ai/chat"), {
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
                        throw new Error(extractErrText(data, resp.status));
                }
                return { message: pickMessage(data) };
        };

        // 强制仅走代理 / 已确认需要走代理 / 尚未配置可直连的 baseURL → 直接代理
        if (
                settings.useProxyOnly ||
                directChannelOk === false ||
                !settings.baseURL.trim()
        ) {
                return tryProxy();
        }

        try {
                return await tryDirect();
        } catch (e) {
                // 用户主动停止：原样抛出，交由上层处理中断
                if (signal.aborted) throw e;
                // CORS / 网络不可达（浏览器抛 TypeError）→ 永久标记需走代理
                if (e instanceof TypeError) directChannelOk = false;
                // 其余任何直连失败（含上游 HTTP 5xx、非 JSON 等瞬态问题）
                // 都回落到带重试的后端代理，而不是直接把错误抛给用户。
                return tryProxy();
        }
};

/* -------------------------------------------------------------------------
 * 流式（SSE）支持：逐字拿到模型输出，让“思考”过程实时显示。
 * 直连与代理两条通道均产出标准 OpenAI SSE 分片，用同一套解析器处理。
 * ------------------------------------------------------------------------- */

interface StreamDeltaToolCall {
	index?: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
}
interface StreamChoice {
	delta?: { content?: string; role?: string; tool_calls?: StreamDeltaToolCall[] };
	message?: { content?: string; tool_calls?: StreamDeltaToolCall[] };
	finish_reason?: string;
}
interface StreamChunk {
	choices?: StreamChoice[];
	error?: unknown;
}
interface AccToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}
interface StreamAcc {
	content: string;
	toolByIndex: Map<number, AccToolCall>;
}

const newAcc = (): StreamAcc => ({ content: "", toolByIndex: new Map() });

/** 把一个 SSE 分片(或整段 message)累加进 acc; 内容增量时回调当前完整文本 */
const applyChunkToAcc = (
	chunk: StreamChunk,
	acc: StreamAcc,
	onContentDelta?: (full: string) => void,
): void => {
	const choice = chunk?.choices?.[0];
	if (!choice) return;
	// 兼容流式 delta 与非流式 message 两种形态
	const d = choice.delta ?? choice.message;
	if (!d) return;
	if (typeof d.content === "string" && d.content) {
		acc.content += d.content;
		onContentDelta?.(acc.content);
	}
	(d.tool_calls ?? []).forEach((tc, i) => {
		const idx = tc.index ?? i;
		const slot: AccToolCall =
			acc.toolByIndex.get(idx) ??
			{ id: "", type: "function", function: { name: "", arguments: "" } };
		if (tc.id) slot.id = tc.id;
		if (tc.type) slot.type = tc.type;
		const fn = tc.function ?? {};
		if (fn.name) slot.function.name += fn.name;
		if (fn.arguments) slot.function.arguments += fn.arguments;
		acc.toolByIndex.set(idx, slot);
	});
};

const finalizeAcc = (acc: StreamAcc): LLMMessage => {
	const message: LLMMessage = { role: "assistant" };
	if (acc.content) message.content = acc.content;
	if (acc.toolByIndex.size) {
		message.tool_calls = [...acc.toolByIndex.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([i, v]) => ({
				id: v.id || `call_${i}_${Date.now().toString(36)}`,
				type: "function" as const,
				function: { name: v.function.name, arguments: v.function.arguments },
			}));
	}
	return message;
};

/** 读取 Response 的 SSE 字节流, 按行解析 data: 分片 */
const consumeSSE = async (
	resp: Response,
	acc: StreamAcc,
	onContentDelta: ((full: string) => void) | undefined,
	signal: AbortSignal,
): Promise<void> => {
	if (!resp.body) {
		const text = await resp.text();
		for (const raw of text.split("\n")) {
			const line = raw.replace(/\r$/, "");
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") return;
			let chunk: StreamChunk;
			try {
				chunk = JSON.parse(payload) as StreamChunk;
			} catch {
				continue;
			}
			if (chunk?.error) throw new Error(String((chunk.error as { message?: string })?.message ?? chunk.error));
			applyChunkToAcc(chunk, acc, onContentDelta);
		}
		return;
	}
	const reader = resp.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		if (signal.aborted) {
			try {
				await reader.cancel();
			} catch {
				/* ignore */
			}
			throw new DOMException("aborted", "AbortError");
		}
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).replace(/\r$/, "");
			buf = buf.slice(nl + 1);
			if (!line.startsWith("data:")) continue;
			const payload = line.slice(5).trim();
			if (payload === "[DONE]") return;
			let chunk: StreamChunk;
			try {
				chunk = JSON.parse(payload) as StreamChunk;
			} catch {
				continue;
			}
			if (chunk?.error)
				throw new Error(
					String((chunk.error as { message?: string })?.message ?? chunk.error),
				);
			applyChunkToAcc(chunk, acc, onContentDelta);
		}
	}
};

/** 发起一次流式请求并把分片累加进 acc */
const runStreamFetch = async (
	url: string,
	init: RequestInit,
	acc: StreamAcc,
	onContentDelta: ((full: string) => void) | undefined,
	signal: AbortSignal,
): Promise<void> => {
	const resp = await fetch(url, { ...init, signal });
	if (!resp.ok) {
		let data: unknown;
		try {
			data = await resp.json();
		} catch {
			data = undefined;
		}
		throw new Error(extractErrText(data ?? {}, resp.status));
	}
	const ctype = resp.headers.get("Content-Type") || "";
	if (ctype.includes("text/event-stream")) {
		await consumeSSE(resp, acc, onContentDelta, signal);
		return;
	}
	// 非 SSE(端点忽略 stream): 当作整段 JSON message 处理
	const text = await resp.text();
	try {
		applyChunkToAcc(JSON.parse(text) as StreamChunk, acc, onContentDelta);
	} catch {
		throw new Error("AI 接口返回了无法解析的内容");
	}
};

/**
 * 流式 chat completion。与 chatCompletion 相同的直连/代理选择与探测缓存；
 * onContentDelta 会携带“当前累计完整文本”用于实时渲染。任一流式环节失败
 * 逐级回落：直连流式→代理流式→非流式 chatCompletion，保证不因流式不支持而中断。
 */
const chatCompletionStream = async (
	settings: AISettings,
	messages: LLMMessage[],
	signal: AbortSignal,
	onContentDelta?: (full: string) => void,
): Promise<{ message: LLMMessage }> => {
	const tools = getToolSchemas();
	resetAIChannelProbe(settings.baseURL);
	const body = {
		model: settings.model,
		temperature: settings.temperature,
		stream: true,
		messages,
		...(tools.length ? { tools, tool_choice: "auto" } : {}),
	};

	const tryDirectStream = async (acc: StreamAcc): Promise<void> => {
		await runStreamFetch(
			buildChatEndpoint(settings.baseURL),
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(settings.apiKey
						? { Authorization: `Bearer ${settings.apiKey}` }
						: {}),
				},
				body: JSON.stringify(body),
			},
			acc,
			onContentDelta,
			signal,
		);
		directChannelOk = true;
	};

	const tryProxyStream = async (acc: StreamAcc): Promise<void> => {
		await runStreamFetch(
			apiUrl("/api/ai/chat/stream"),
			{
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
			},
			acc,
			onContentDelta,
			signal,
		);
	};

	// 强制仅代理 / 已确认需代理 / 未配置可直连 baseURL → 直接代理流式
	if (
		settings.useProxyOnly ||
		directChannelOk === false ||
		!settings.baseURL.trim()
	) {
		const acc = newAcc();
		try {
			await tryProxyStream(acc);
			return { message: finalizeAcc(acc) };
		} catch (e) {
			if (signal.aborted) throw e;
			const { message } = await chatCompletion(settings, messages, signal);
			return { message };
		}
	}

	const acc = newAcc();
	try {
		await tryDirectStream(acc);
		return { message: finalizeAcc(acc) };
	} catch (e) {
		if (signal.aborted) throw e;
		if (e instanceof TypeError) directChannelOk = false;
		// 直连流式失败 → 代理流式; 再失败 → 非流式兜底
		const acc2 = newAcc();
		try {
			await tryProxyStream(acc2);
			return { message: finalizeAcc(acc2) };
		} catch (e2) {
			if (signal.aborted) throw e2;
			const { message } = await chatCompletion(settings, messages, signal);
			return { message };
		}
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
                        streaming: false,
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
                        const prevAnswer = turn.answer;
                        let streamedContent = "";
                        const { message } = await chatCompletionStream(
                                settings,
                                [{ role: "system", content: buildSystemPrompt() }, ...llmMessages],
                                controller.signal,
                                (full) => {
                                        streamedContent = full;
                                        // 本轮文本实时呈现为答案(若本轮其实是工具调用, 稍后回滚)
                                        updateTurn(turn.id, (t) => ({
                                                ...t,
                                                answer: full,
                                                streaming: true,
                                        }));
                                },
                        );
                        updateStep(turn.id, thinkStepId, {
                                status: "done",
                                durationMs: Math.round(performance.now() - thinkStart),
                        });

                        const toolCalls = extractToolCalls(message);
                        if (toolCalls.length > 0) {
                                // 本轮为工具调用: 回滚本轮临时流式文本, 恢复上一轮已提交答案
                                updateTurn(turn.id, (t) => ({
                                        ...t,
                                        answer: prevAnswer,
                                        streaming: false,
                                }));
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

                        // 最终回答(流式已逐字呈现, 此处以完整文本为准收尾)
                        const answer = (message.content ?? streamedContent ?? "").trim();
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
                const resp = await fetch(apiUrl("/api/test-ai"), {
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
