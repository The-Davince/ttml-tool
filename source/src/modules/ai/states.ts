import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/**
 * AI 助手
 *
 * 类 MCP 架构：前端运行 Agent 循环，通过本地 server.py 代理访问
 * OpenAI 兼容的大模型接口，模型通过工具调用（function calling）
 * 直接操作歌词编辑器与网页搜索。
 */

export interface AISettings {
	/** OpenAI 兼容 API Base URL，如 https://api.openai.com/v1 */
	baseURL: string;
	/** 模型名称，如 gpt-4o-mini / glm-4-flash / deepseek-chat */
	model: string;
	/** API Key（仅保存在本地浏览器 localStorage，经本地代理转发） */
	apiKey: string;
	/** 采样温度 */
	temperature: number;
	/**
	 * 后端代理（server.py）的基础地址，如 http://127.0.0.1:26013。
	 * 留空 = 同源相对路径 /api/...（线上/经 vite 代理时即此情形）。
	 * 设为绝对地址可让前端指向另一个后端（需该后端开启 CORS）。
	 */
	backendBaseURL?: string;
	/**
	 * 强制「仅走后端代理」：为 true 时跳过浏览器直连，始终经 server.py 转发。
	 * 用于直连端点不稳定（偶发 HTTP 500 / CORS 拦截）时获得更鲁棒的链路（代理自带重试）。
	 */
	useProxyOnly?: boolean;
}

const SETTINGS_STORAGE_KEY = "aiAssistantSettings";

/** 读取当前配置的后端代理基址（直读 localStorage，供非 React 环境如 tools.ts 使用） */
export const getBackendBaseURL = (): string => {
	try {
		const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
		if (!raw) return "";
		const parsed = JSON.parse(raw) as { backendBaseURL?: unknown };
		let v =
			typeof parsed?.backendBaseURL === "string"
				? parsed.backendBaseURL.trim()
				: "";
		v = v.replace(/\/+$/, "");
		if (!v) return "";
		// 归一化：只填了 host:port（缺协议）时补上 http://，
		// 否则会被浏览器当作相对路径拼到当前 origin 后面（如 /127.0.0.1:26013/api）。
		if (!/^https?:\/\//i.test(v)) {
			v = `http://${v}`;
		}
		return v;
	} catch {
		return "";
	}
};

/** 把 /api/... 相对路径拼成实际后端地址（未配置则原样返回，走同源） */
export const apiUrl = (path: string): string => {
	const base = getBackendBaseURL();
	return base ? `${base}${path}` : path;
};

export const AI_PRESETS: Array<{
	name: string;
	baseURL: string;
	model: string;
	note: string;
}> = [
	{
		name: "智谱 GLM",
		baseURL: "https://open.bigmodel.cn/api/paas/v4",
		model: "glm-4-flash",
		note: "glm-4-flash 免费额度大，推荐入门",
	},
	{
		name: "DeepSeek",
		baseURL: "https://api.deepseek.com/v1",
		model: "deepseek-chat",
		note: "便宜好用，支持工具调用",
	},
	{
		name: "OpenAI",
		baseURL: "https://api.openai.com/v1",
		model: "gpt-4o-mini",
		note: "官方接口",
	},
	{
		name: "Kimi",
		baseURL: "https://api.moonshot.cn/v1",
		model: "moonshot-v1-8k",
		note: "月之暗面",
	},
	{
		name: "硅基流动",
		baseURL: "https://api.siliconflow.cn/v1",
		model: "Qwen/Qwen2.5-72B-Instruct",
		note: "聚合平台，有多种免费模型",
	},
	{
		name: "Ollama 本地",
		baseURL: "http://localhost:11434/v1",
		model: "qwen2.5:7b",
		note: "本地运行无需 Key（需支持工具调用的模型）",
	},
];

export const aiSettingsAtom = atomWithStorage<AISettings>(
	"aiAssistantSettings",
	{
		baseURL: "",
		model: "",
		apiKey: "",
		temperature: 0.2,
		// 后端代理地址默认取「当前网页地址」(window.location.origin)：
		// 发布包由 server.py 同源提供页面与 /api，故默认即指向本机后端，
		// 无论跑在哪个 host:port 都能自动对接；本地开发留空亦可（Vite 代理 /api）。
		backendBaseURL:
			typeof window !== "undefined" ? window.location.origin : "",
		useProxyOnly: false,
	},
	undefined,
	// 挂载时同步读取存储值，避免首次渲染误判为“未配置”
	{ getOnInit: true },
);

/** Agent 执行过程中的单个步骤（实时展示给用户） */
export interface AIStep {
	id: string;
	kind: "thinking" | "tool" | "answer" | "error" | "abort";
	/** 展示标题 */
	title: string;
	/** 工具名（kind=tool） */
	toolName?: string;
	/** 工具参数 */
	argsJson?: string;
	/** 执行结果详情 */
	detail?: string;
	/** 结果数据（工具返回值） */
	resultJson?: string;
	status: "running" | "done" | "error";
	durationMs?: number;
}

/** 一轮对话（用户输入 → 若干步骤 → 最终回答） */
export interface AITurn {
	id: string;
	userText: string;
	steps: AIStep[];
	answer?: string;
	/** 最终回答正在逐字流式生成中(用于展示光标) */
	streaming?: boolean;
	status: "running" | "done" | "error" | "aborted";
	error?: string;
	time: number;
}

export const aiTurnsAtom = atom<AITurn[]>([]);
export const aiRunningAtom = atom(false);

/** 设置视图是否打开 */
export const aiSettingsViewAtom = atom(false);

let stepSeq = 0;
export const nextAIStepId = () =>
	`aistep-${Date.now().toString(36)}-${(stepSeq++).toString(36)}`;

let turnSeq = 0;
export const nextAITurnId = () =>
	`aiturn-${Date.now().toString(36)}-${(turnSeq++).toString(36)}`;

export const isAIConfigured = (settings: AISettings) =>
	Boolean(settings.baseURL.trim() && settings.model.trim());
