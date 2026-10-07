import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/**
 * 右侧工具窗口可用的标签页类型
 *
 * 未来扩展新标签页时：
 * 1. 在此联合类型中追加类型名
 * 2. 在 components/ToolWindow/tabs.tsx 的 TOOL_TAB_DEFS 中注册图标与渲染内容
 * 3. 新标签页会自动出现在 "+" 按钮的菜单中
 */
export type ToolTabType = "preview" | "ai";

export interface ToolTab {
        id: string;
        type: ToolTabType;
        createdAt: number;
}

/** 工具窗口是否打开（持久化，刷新页面后保留） */
export const toolWindowOpenAtom = atomWithStorage("toolWindowOpen", false);

/**
 * 点击歌词行切换右侧工具窗口（持久化，默认开启）
 * 开启后：在编辑界面点击歌词行显示工具窗口，再次点击同一行将其隐藏
 */
export const lineClickTogglesToolWindowAtom = atomWithStorage(
        "lineClickTogglesToolWindow",
        true,
);

/** 工具窗口宽度（像素，持久化，拖拽松手时写入） */
export const toolWindowWidthAtom = atomWithStorage("toolWindowWidth", 400);

export const TOOL_WINDOW_MIN_WIDTH = 280;
export const TOOL_WINDOW_MAX_WIDTH = 900;

export const TOOL_WINDOW_MIN_FONT_SIZE = 14;
export const TOOL_WINDOW_MAX_FONT_SIZE = 56;
export const TOOL_WINDOW_DEFAULT_FONT_SIZE = 22;

/** 工具窗口歌词字号（像素，0 = 自动跟随页面尺寸），持久化，默认开启自动缩放 */
export const toolWindowFontSizeAtom = atomWithStorage(
        "toolWindowFontSize",
        0,
);

/** 当前打开的标签页列表（会话级，关闭窗口时清空） */
export const toolTabsAtom = atom<ToolTab[]>([]);

/** 当前激活的标签页 ID */
export const activeToolTabIdAtom = atom<string | null>(null);

let tabSeq = 0;
const nextTabId = (type: ToolTabType) =>
        `${type}-${Date.now().toString(36)}-${(tabSeq++).toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 6)}`;

/** 新建一个标签页并激活 */
export const openToolTabAtom = atom(null, (_get, set, type: ToolTabType) => {
        const tab: ToolTab = { id: nextTabId(type), type, createdAt: Date.now() };
        set(toolTabsAtom, (tabs) => [...tabs, tab]);
        set(activeToolTabIdAtom, tab.id);
});

/** 关闭指定标签页，激活相邻标签页（优先右侧，与浏览器行为一致） */
export const closeToolTabAtom = atom(null, (get, set, tabId: string) => {
        const tabs = get(toolTabsAtom);
        const index = tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return;
        const next = tabs.filter((tab) => tab.id !== tabId);
        set(toolTabsAtom, next);
        if (get(activeToolTabIdAtom) === tabId) {
                set(activeToolTabIdAtom, next[Math.min(index, next.length - 1)]?.id ?? null);
        }
});

/** 关闭整个工具窗口并清空标签页（下次打开默认无标签页） */
export const closeToolWindowAtom = atom(null, (_get, set) => {
        set(toolWindowOpenAtom, false);
        set(toolTabsAtom, []);
        set(activeToolTabIdAtom, null);
});
