import { Bot24Regular, Eye24Regular } from "@fluentui/react-icons";
import { lazy, type ReactNode } from "react";
import SuspensePlaceHolder from "$/components/SuspensePlaceHolder";
import type { ToolTabType } from "$/modules/settings/states/tool-window";

const AMLLWrapper = lazy(() => import("$/components/AMLLWrapper"));
const AIAssistantPanel = lazy(() => import("$/modules/ai/components/AIAssistantPanel"));

export interface ToolTabDef {
	/** 标签页类型标识 */
	type: ToolTabType;
	/** 标签页图标 */
	icon: ReactNode;
	/** 标签页标题的 i18n 词条键 */
	labelKey: string;
	/** 渲染标签页内容 */
	render: () => ReactNode;
}

/**
 * 工具窗标签页注册表
 */
export const TOOL_TAB_DEFS: ToolTabDef[] = [
	{
		type: "preview",
		icon: <Eye24Regular />,
		labelKey: "toolWindow.tab.preview",
		render: () => (
			<SuspensePlaceHolder>
				<AMLLWrapper />
			</SuspensePlaceHolder>
		),
	},
	{
		type: "ai",
		icon: <Bot24Regular />,
		labelKey: "toolWindow.tab.ai",
		render: () => (
			<SuspensePlaceHolder>
				<AIAssistantPanel />
			</SuspensePlaceHolder>
		),
	},
];

export const getToolTabDef = (type: ToolTabType) =>
	TOOL_TAB_DEFS.find((def) => def.type === type);
