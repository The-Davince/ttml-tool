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
}

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
