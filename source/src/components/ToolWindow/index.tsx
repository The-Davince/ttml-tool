import {
	Add24Regular,
	AddCircle24Regular,
	Dismiss24Regular,
} from "@fluentui/react-icons";
import { DropdownMenu, IconButton, Tooltip } from "@radix-ui/themes";
import { AnimatePresence, motion } from "framer-motion";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	memo,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	activeToolTabIdAtom,
	closeToolTabAtom,
	closeToolWindowAtom,
	openToolTabAtom,
	TOOL_WINDOW_MAX_WIDTH,
	TOOL_WINDOW_MIN_WIDTH,
	toolTabsAtom,
	toolWindowFontSizeAtom,
	toolWindowWidthAtom,
} from "$/modules/settings/states/tool-window";
import { getToolTabDef, TOOL_TAB_DEFS } from "./tabs";
import styles from "./index.module.css";

const openTransition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] } as const;
const snapTransition = { duration: 0 } as const;

const clampWidth = (width: number) => {
	const maxByViewport = Math.max(
		TOOL_WINDOW_MIN_WIDTH,
		Math.min(TOOL_WINDOW_MAX_WIDTH, window.innerWidth - 420),
	);
	return Math.max(
		TOOL_WINDOW_MIN_WIDTH,
		Math.min(maxByViewport, Math.round(width)),
	);
};

/**
 * 工具窗口
 */
export const ToolWindow = memo(() => {
	const { t } = useTranslation();
	const tabs = useAtomValue(toolTabsAtom);
	const [activeTabId, setActiveTabId] = useAtom(activeToolTabIdAtom);
	const [savedWidth, setSavedWidth] = useAtom(toolWindowWidthAtom);
	const fontSize = useAtomValue(toolWindowFontSizeAtom);
	const setTabs = useSetAtom(toolTabsAtom);
	const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);

	const tabsRowRef = useRef<HTMLDivElement>(null);
	const moveTabToRef = useRef<(fromId: string, toIndex: number) => void>(() => {});
	const dropTargetIndexRef = useRef<number | null>(null);
	const draggingTabIdRef = useRef<string | null>(null);
	dropTargetIndexRef.current = dropTargetIndex;
	draggingTabIdRef.current = draggingTabId;

	useEffect(() => {
		const el = tabsRowRef.current;
		if (!el) return;
		const resetDrag = () => {
			delete el.dataset.draggingTabId;
			setDraggingTabId(null);
			setDropTargetIndex(null);
		};
		const onDragStart = (e: DragEvent) => {
			const tabEl = (e.target as HTMLElement).closest?.('[role=tab]');
			if (!tabEl || !e.dataTransfer) return;
			const id = tabEl.getAttribute('data-tab-id');
			if (!id) return;
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', id);
			el.dataset.draggingTabId = id;
			setDraggingTabId(id);
		};
		const onDragOver = (e: DragEvent) => {
			const tabEl = (e.target as HTMLElement).closest?.('[role=tab]');
			if (!tabEl || !e.dataTransfer) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			const rect = tabEl.getBoundingClientRect();
			const after = e.clientX > rect.left + rect.width / 2;
			const idx = Number(tabEl.getAttribute('data-tab-index'));
			setDropTargetIndex(idx + (after ? 1 : 0));
		};
		const onDrop = (e: DragEvent) => {
			e.preventDefault();
			const id =
				e.dataTransfer?.getData('text/plain') ||
				draggingTabIdRef.current ||
				el.dataset.draggingTabId;
			let target = dropTargetIndexRef.current;
			if (target === null) {
				const tabEl = (e.target as HTMLElement).closest?.('[role=tab]');
				if (tabEl) {
					const idx = Number(tabEl.getAttribute('data-tab-index'));
					const rect = tabEl.getBoundingClientRect();
					const after = e.clientX > rect.left + rect.width / 2;
					target = idx + (after ? 1 : 0);
				}
			}
			if (id && target !== null) {
				moveTabToRef.current(id, target);
			}
			resetDrag();
		};
		const onDragEnd = () => resetDrag();
		el.addEventListener('dragstart', onDragStart);
		el.addEventListener('dragover', onDragOver);
		el.addEventListener('drop', onDrop);
		el.addEventListener('dragend', onDragEnd);
		return () => {
			el.removeEventListener('dragstart', onDragStart);
			el.removeEventListener('dragover', onDragOver);
			el.removeEventListener('drop', onDrop);
			el.removeEventListener('dragend', onDragEnd);
		};
	}, []);

	const moveTabTo = useCallback(
		(fromId: string, toIndex: number) => {
			setTabs((prev) => {
				const fromIndex = prev.findIndex((tab) => tab.id === fromId);
				if (fromIndex < 0 || toIndex < 0 || toIndex > prev.length) return prev;
				const next = [...prev];
				const [moved] = next.splice(fromIndex, 1);
				const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
				next.splice(insertIndex, 0, moved);
				return next;
			});
		},
		[setTabs],
	);
	moveTabToRef.current = moveTabTo;
	const openTab = useSetAtom(openToolTabAtom);
	const closeTab = useSetAtom(closeToolTabAtom);
	const closeWindow = useSetAtom(closeToolWindowAtom);
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const dragWidthRef = useRef<number | null>(null);
	const dragging = dragWidth !== null;
	const width = dragWidth ?? clampWidth(savedWidth);

	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
	const activeDef = activeTab ? getToolTabDef(activeTab.type) : null;

	const typeCounts = new Map<string, number>();
	for (const tab of tabs) {
		typeCounts.set(tab.type, (typeCounts.get(tab.type) ?? 0) + 1);
	}
	// 编号按创建顺序分配：拖动换位后编号跟随标签页本身，
	// 这样用户能直观看到标签页的位置发生了变化
	const tabNumberById = new Map<string, number>();
	for (const [type, count] of typeCounts) {
		if (count <= 1) continue;
		const sameType = tabs
			.filter((tab) => tab.type === type)
			.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
		sameType.forEach((tab, i) => tabNumberById.set(tab.id, i + 1));
	}

	const onResizePointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const startX = e.clientX;
			const startWidth = width;
			const prevUserSelect = document.body.style.userSelect;
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";
			const onMove = (ev: PointerEvent) => {
				const next = clampWidth(startWidth + (startX - ev.clientX));
				dragWidthRef.current = next;
				setDragWidth(next);
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				document.body.style.userSelect = prevUserSelect;
				document.body.style.cursor = "";
				if (dragWidthRef.current !== null) {
					setSavedWidth(dragWidthRef.current);
				}
				dragWidthRef.current = null;
				setDragWidth(null);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[width, setSavedWidth],
	);

	return (
		<div className={styles.windowWrap}>
			<div
				className={styles.resizeHandle}
				data-dragging={dragging || undefined}
				onPointerDown={onResizePointerDown}
				role="separator"
				aria-orientation="vertical"
				aria-label={t("toolWindow.resize", "拖动调整宽度")}
			/>
			<motion.div
				className={styles.windowShell}
				initial={{ width: 0, opacity: 0 }}
				animate={{ width: width, opacity: 1 }}
				exit={{ width: 0, opacity: 0 }}
				transition={dragging ? snapTransition : openTransition}
			>
				<div className={styles.windowInner} style={{ width: width }}>
					<header className={styles.tabBar}>
					<div
						ref={tabsRowRef}
						className={styles.tabsRow}
						role="tablist"
						aria-label={t("settings.toolWindow.title", "工具窗口")}
					>
						<AnimatePresence initial={false}>
						{tabs.map((tab, index) => {
							const def = getToolTabDef(tab.type);
							if (!def) return null;
							const tabNumber = tabNumberById.get(tab.id);
							const label =
								t(def.labelKey as never) + (tabNumber ? ` ${tabNumber}` : "");
							const active = tab.id === activeTab?.id;
							return (
								<motion.div
									key={tab.id}
									className={styles.tab}
									layout
									initial={{ maxWidth: 0, opacity: 0 }}
									animate={{ maxWidth: 168, opacity: 1 }}
									exit={{ maxWidth: 0, opacity: 0 }}
									transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
									role="tab"
									tabIndex={0}
									aria-selected={active}
									data-active={active || undefined}
									data-tab-id={tab.id}
									data-tab-index={index}
									data-dragging={draggingTabId === tab.id || undefined}
									data-drop-before={
										(dropTargetIndex === index && draggingTabId !== tab.id) || undefined
									}
									data-drop-after={
										(dropTargetIndex === index + 1 && draggingTabId !== tab.id) || undefined
									}
									title={label}
									draggable
									onClick={() => setActiveTabId(tab.id)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											setActiveTabId(tab.id);
										}
									}}
								>
									<span className={styles.tabIcon}>{def.icon}</span>
									<span className={styles.tabLabel}>{label}</span>
									<button
										type="button"
										className={styles.tabClose}
										aria-label={t("toolWindow.closeTab", "关闭标签页")}
										onClick={(e) => {
											e.stopPropagation();
											closeTab(tab.id);
										}}
									>
										<Dismiss24Regular />
									</button>
								</motion.div>
							);
						})}
						</AnimatePresence>
						<DropdownMenu.Root>
							{/* Radix Themes 类型定义暂缺 asChild，运行时已验证支持 */}
							<DropdownMenu.Trigger {...({ asChild: true } as unknown as Record<string, unknown>)}>
								<IconButton
									className={styles.addButton}
									size="1"
									variant="ghost"
									color="gray"
									aria-label={t("toolWindow.newTab", "新建标签页")}
									title={t("toolWindow.newTab", "新建标签页")}
								>
									<Add24Regular />
								</IconButton>
							</DropdownMenu.Trigger>
							<DropdownMenu.Content
								side="bottom"
								align="start"
								sideOffset={4}
							>
								{TOOL_TAB_DEFS.map((def) => (
									<DropdownMenu.Item
										key={def.type}
										onSelect={() => openTab(def.type)}
									>
										{def.icon}
										{t(def.labelKey as never)}
									</DropdownMenu.Item>
								))}
							</DropdownMenu.Content>
						</DropdownMenu.Root>
					</div>
					<Tooltip content={t("toolWindow.close", "关闭工具窗口")}>
						<IconButton
							className={styles.closeButton}
							size="1"
							variant="ghost"
							color="gray"
							onClick={closeWindow}
							aria-label={t("toolWindow.close", "关闭工具窗口")}
						>
							<Dismiss24Regular />
						</IconButton>
					</Tooltip>
				</header>
				<div className={styles.tabContent}>
					{activeTab && activeDef ? (
						<div
							className={styles.tabPane}
							key={activeTab.id}
							style={
									fontSize > 0
											? ({
														"--amll-lp-font-size": `${fontSize}px`,
													} as CSSProperties)
											: undefined
									}
						>
							{activeDef.render()}
						</div>
					) : (
						<div className={styles.emptyState}>
							<AddCircle24Regular className={styles.emptyIcon} />
							<span className={styles.emptyText}>
								{t("toolWindow.emptyHint", "点击左上角的 + 添加标签页")}
							</span>
						</div>
					)}
				</div>
			</div>
		</motion.div>
		</div>
	);
});
