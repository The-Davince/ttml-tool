import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export interface AISettings {
	baseURL: string;
	model: string;
	apiKey: string;
	temperature: number;
	/**
	 * server.py的基础地址
	 * 留空则使用同源相对path
	 */
	backendBaseURL?: string;
	useProxyOnly?: boolean;
}

const SETTINGS_STORAGE_KEY = "aiAssistantSettings";

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
		if (!/^https?:\/\//i.test(v)) {
			v = `http://${v}`;
		}
		return v;
	} catch {
		return "";
	}
};

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
		backendBaseURL:
			typeof window !== "undefined" ? window.location.origin : "",
		useProxyOnly: false,
	},
	undefined,
	{ getOnInit: true },
);

export interface AIStep {
	id: string;
	kind: "thinking" | "tool" | "answer" | "error" | "abort";
	title: string;
	toolName?: string;
	argsJson?: string;
	detail?: string;
	resultJson?: string;
	status: "running" | "done" | "error";
	durationMs?: number;
}

export interface AITurn {
	id: string;
	userText: string;
	steps: AIStep[];
	answer?: string;
	streaming?: boolean;
	status: "running" | "done" | "error" | "aborted";
	error?: string;
	time: number;
}

export const aiTurnsAtom = atom<AITurn[]>([]);
export const aiRunningAtom = atom(false);
export const aiSettingsViewAtom = atom(false);

let stepSeq = 0;
export const nextAIStepId = () =>
	`aistep-${Date.now().toString(36)}-${(stepSeq++).toString(36)}`;

let turnSeq = 0;
export const nextAITurnId = () =>
	`aiturn-${Date.now().toString(36)}-${(turnSeq++).toString(36)}`;

export const isAIConfigured = (settings: AISettings) =>
	Boolean(settings.baseURL.trim() && settings.model.trim());
