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

let directChannelOk: boolean | null = null;
let probedBaseURL = "";

export const resetAIChannelProbe = (baseURL: string) => {
        if (probedBaseURL !== baseURL) {
                directChannelOk = null;
                probedBaseURL = baseURL;
        }
};

const buildChatEndpoint = (baseURL: string): string => {
        const b = baseURL.trim().replace(/\/+$/, "");
        return b.endsWith("/chat/completions") ? b : `${b}/chat/completions`;
};

const pickMessage = (data: unknown): LLMMessage => {
        const choices = (data as { choices?: Array<{ message?: LLMMessage }> })
                .choices;
        const message = choices?.[0]?.message;
        if (!message) throw new Error("AI 接口响应中缺少 choices[0].message");
        return message;
};

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
                if (signal.aborted) throw e;
                if (e instanceof TypeError) directChannelOk = false;
                return tryProxy();
        }
};

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

const applyChunkToAcc = (
	chunk: StreamChunk,
	acc: StreamAcc,
	onContentDelta?: (full: string) => void,
): void => {
	const choice = chunk?.choices?.[0];
	if (!choice) return;
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
	const text = await resp.text();
	try {
		applyChunkToAcc(JSON.parse(text) as StreamChunk, acc, onContentDelta);
	} catch {
		throw new Error("AI 接口返回了无法解析的内容");
	}
};

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

const extractToolCalls = (
        message: LLMMessage,
): NonNullable<LLMMessage["tool_calls"]> => {
        if (message.tool_calls?.length) return message.tool_calls;
        return parseTextToolCalls(message.content ?? "");
};

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
                                updateTurn(turn.id, (t) => ({
                                        ...t,
                                        answer: prevAnswer,
                                        streaming: false,
                                }));
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
