import {
	ArrowHookUpLeft20Filled,
	ArrowHookUpLeft20Regular,
	DocumentArrowLeft20Regular,
	History24Regular,
	Person24Regular,
	Sparkle24Regular,
} from "@fluentui/react-icons";
import { Button } from "@radix-ui/themes";
import { AnimatePresence, motion } from "framer-motion";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	applyHistoryLimitAtom,
	clearHistoryAtom,
	getHistorySourceLabel,
	type HistoryEntry,
	type HistorySource,
	historyEntriesAtom,
	historyMaxEntriesAtom,
	MAX_HISTORY_LIMIT,
	MIN_HISTORY_LIMIT,
	restoreHistoryEntryAtom,
} from "$/modules/history/states";
import styles from "./HistoryPanel.module.css";

const SOURCE_ICONS: Record<HistorySource, React.ReactNode> = {
	human: <Person24Regular />,
	ai: <Sparkle24Regular />,
	restore: <ArrowHookUpLeft20Filled />,
	load: <DocumentArrowLeft20Regular />,
};

const formatTime = (time: number) =>
	new Date(time).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

/** 悬停"还原"节点时，绘制到源版本的圆角"地铁肘形"连线路径 */
const metroElbow = (x1: number, y1: number, x2: number, y2: number) => {
	const dir = y2 >= y1 ? 1 : -1;
	// 连线走主线左侧的一条副轨道（laneX），越靠左越像 git graph 的分叉泳道
	const laneX = Math.max(3, Math.min(x1, x2) - 16);
	const rr = Math.max(3, Math.min(12, Math.abs(y2 - y1) / 2, Math.abs(x1 - laneX)));
	return [
		`M ${x1} ${y1}`,
		`L ${laneX + rr} ${y1}`,
		`Q ${laneX} ${y1} ${laneX} ${y1 + dir * rr}`,
		`L ${laneX} ${y2 - dir * rr}`,
		`Q ${laneX} ${y2} ${laneX + rr} ${y2}`,
		`L ${x2} ${y2}`,
	].join(" ");
};

/** 单条版本记录（地铁线路上的一个"站点"，精简为一行） */
const EntryRow = ({
	entry,
	sourceCode,
	isHoveredSource,
	isActiveRestore,
	onHoverRestore,
	onRestore,
}: {
	entry: HistoryEntry;
	sourceCode: string | undefined;
	isHoveredSource: boolean;
	isActiveRestore: boolean;
	onHoverRestore: (restoreId: string | undefined, sourceId: string | undefined) => void;
	onRestore: (id: string) => void;
}) => {
	const { t } = useTranslation();
	const tooltip = [
		t(`history.source.${entry.source}`, { defaultValue: getHistorySourceLabel(entry.source) }),
		t("history.lineCount", { defaultValue: "{count} 行", count: entry.lineCount }),
		t("history.wordCount", { defaultValue: "{count} 个音节", count: entry.wordCount }),
		new Date(entry.time).toLocaleString(),
	].join(" · ");

	return (
		<div
			className={styles.entry}
			data-source={entry.source}
			data-highlight={isHoveredSource || undefined}
			data-active={isActiveRestore || undefined}
			title={tooltip}
			onMouseEnter={() =>
				entry.source === "restore" && entry.restoreOf
					? onHoverRestore(entry.id, entry.restoreOf)
					: onHoverRestore(undefined, undefined)
			}
			onMouseLeave={() => onHoverRestore(undefined, undefined)}
		>
			<span className={styles.entryDot} data-node-id={entry.id}>
				{SOURCE_ICONS[entry.source]}
			</span>
			<span className={styles.codeChip}>#{entry.code}</span>
			<span className={styles.description}>{entry.description}</span>
			{entry.source === "restore" && sourceCode && (
				<span className={styles.restoreRef}>
					<ArrowHookUpLeft20Regular />#{sourceCode}
				</span>
			)}
			<span className={styles.entryTime}>{formatTime(entry.time)}</span>
			<Button
				className={styles.restoreButton}
				size="1"
				variant="surface"
				color="gray"
				title={t("history.restore", "还原到此版本")}
				onClick={() => onRestore(entry.id)}
			>
				<ArrowHookUpLeft20Regular />
			</Button>
		</div>
	);
};

/** 上限设置行 */
const LimitSettings = () => {
	const { t } = useTranslation();
	const [maxEntries, setMaxEntries] = useAtom(historyMaxEntriesAtom);
	const applyLimit = useSetAtom(applyHistoryLimitAtom);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(String(maxEntries));

	const clamp = (v: number) =>
		Math.min(MAX_HISTORY_LIMIT, Math.max(MIN_HISTORY_LIMIT, v));

	return (
		<div className={styles.limitRow}>
			{editing ? (
				<>
					<span className={styles.limitLabel}>
						{t("history.maxEntries", "最多保留")}
					</span>
					<input
						className={styles.limitInput}
						type="number"
						min={MIN_HISTORY_LIMIT}
						max={MAX_HISTORY_LIMIT}
						step={10}
						value={draft}
						autoFocus
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								const v = clamp(Number.parseInt(draft, 10) || 100);
								setMaxEntries(v);
								applyLimit(v);
								setDraft(String(v));
								setEditing(false);
							} else if (e.key === "Escape") {
								setDraft(String(maxEntries));
								setEditing(false);
							}
						}}
					/>
					<span className={styles.limitLabel}>
						{t("history.maxEntriesUnit", "条")}
					</span>
					<Button
						size="1"
						variant="soft"
						onClick={() => {
							const v = clamp(Number.parseInt(draft, 10) || 100);
							setMaxEntries(v);
							applyLimit(v);
							setDraft(String(v));
							setEditing(false);
						}}
					>
						{t("history.apply", "应用")}
					</Button>
				</>
			) : (
				<>
					<span className={styles.limitLabel}>
						{t("history.maxEntries", "最多保留")} {maxEntries}{" "}
						{t("history.maxEntriesUnit", "条")}
					</span>
					{[50, 200, 500].map((v) => (
						<button
							key={v}
							type="button"
							className={styles.limitPreset}
							data-active={v === maxEntries || undefined}
							onClick={() => {
								setMaxEntries(v);
								applyLimit(v);
							}}
						>
							{v}
						</button>
					))}
					<button
						type="button"
						className={styles.limitPreset}
						onClick={() => setEditing(true)}
					>
						{t("history.custom", "自定义")}
					</button>
				</>
			)}
		</div>
	);
};

export const HistoryPanel = () => {
	const { t } = useTranslation();
	const entries = useAtomValue(historyEntriesAtom);
	const restoreEntry = useSetAtom(restoreHistoryEntryAtom);
	const clearHistory = useSetAtom(clearHistoryAtom);
	const listRef = useRef<HTMLDivElement>(null);
	const timelineRef = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<{
		restoreId: string;
		sourceId: string;
	} | null>(null);
	const [curveD, setCurveD] = useState<string | null>(null);

	// 展示顺序：最新在前
	const ordered = [...entries].reverse();
	const codeById = new Map(entries.map((e) => [e.id, e.code] as const));

	// 新记录到达时滚动到顶部（最新）
	const prevCountRef = useRef(entries.length);
	useEffect(() => {
		if (entries.length > prevCountRef.current && listRef.current) {
			listRef.current.scrollTo({ top: 0, behavior: "smooth" });
		}
		prevCountRef.current = entries.length;
	}, [entries.length]);

	// 仅测量当前悬停的"还原 → 源版本"连线（不再常驻全部曲线）
	const measure = () => {
		const container = timelineRef.current;
		if (!container || !hover) {
			setCurveD(null);
			return;
		}
		const rect = container.getBoundingClientRect();
		const fromEl = container.querySelector(
			`[data-node-id="${hover.restoreId}"]`,
		);
		const toEl = container.querySelector(`[data-node-id="${hover.sourceId}"]`);
		if (!fromEl || !toEl) {
			setCurveD(null);
			return;
		}
		const from = fromEl.getBoundingClientRect();
		const to = toEl.getBoundingClientRect();
		const y1 = from.top + from.height / 2 - rect.top;
		const y2 = to.top + to.height / 2 - rect.top;
		const x = from.left + from.width / 2 - rect.left;
		const x2 = to.left + to.width / 2 - rect.left;
		setCurveD(metroElbow(x, y1, x2, y2));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: 连线依赖 DOM 渲染结果，hover/记录变化或列表滚动/缩放时重算
	useEffect(measure, [hover, entries]);
	useEffect(() => {
		const list = listRef.current;
		window.addEventListener("resize", measure);
		list?.addEventListener("scroll", measure, { passive: true });
		return () => {
			window.removeEventListener("resize", measure);
			list?.removeEventListener("scroll", measure);
		};
	});

	const onRestore = (id: string) => {
		restoreEntry(id);
		toast.success(
			t("history.restored", {
				defaultValue: "已还原到 {time} 的版本",
				time: formatTime(entries.find((e) => e.id === id)?.time ?? 0),
			}),
		);
	};

	return (
		<div className={styles.historyPanel}>
			<div className={styles.header}>
				<div className={styles.headerTitle}>
					<History24Regular />
					<span>{t("history.title", "历史操作")}</span>
					{entries.length > 0 && (
						<span className={styles.countBadge}>{entries.length}</span>
					)}
				</div>
				{entries.length > 0 && (
					<Button
						size="1"
						variant="ghost"
						color="gray"
						onClick={() => {
							if (
								window.confirm(
									t("history.clearConfirm", "确定要清空全部历史记录吗？"),
								)
							) {
								clearHistory();
							}
						}}
					>
						{t("history.clear", "清空")}
					</Button>
				)}
			</div>

			<LimitSettings />

			<div className={styles.legend}>
				<span className={styles.legendItem} data-source="human">
					<span className={styles.legendDot} />
					{t("history.source.human", "手动")}
				</span>
				<span className={styles.legendItem} data-source="ai">
					<span className={styles.legendDot} />
					{t("history.source.ai", "AI")}
				</span>
				<span className={styles.legendItem} data-source="restore">
					<span className={styles.legendDot} />
					{t("history.source.restore", "还原")}
				</span>
				<span className={styles.legendItem} data-source="load">
					<span className={styles.legendDot} />
					{t("history.source.load", "载入")}
				</span>
			</div>

			<div className={styles.list} ref={listRef}>
				{entries.length === 0 ? (
					<div className={styles.empty}>
						<History24Regular className={styles.emptyIcon} />
						<span>{t("history.empty", "暂无历史记录")}</span>
						<span style={{ fontSize: 12 }}>
							{t(
								"history.emptyHint",
								"人工或 AI 对歌词的每一次更改都会记录在这里",
							)}
						</span>
					</div>
				) : (
					<div className={styles.timeline} ref={timelineRef}>
						<div className={styles.nowMarker}>
							<span className={styles.nowDot} />
							<span>{t("history.current", "当前版本")}</span>
						</div>
						<svg className={styles.curveLayer} aria-hidden="true">
							{curveD && <path className={styles.curvePath} d={curveD} />}
						</svg>
						<AnimatePresence initial={false}>
							{ordered.map((entry) => (
								<motion.div
									key={entry.id}
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: 0.15 }}
								>
									<EntryRow
										entry={entry}
										sourceCode={
											entry.restoreOf
												? codeById.get(entry.restoreOf)
												: undefined
										}
										isHoveredSource={hover?.sourceId === entry.id}
										isActiveRestore={hover?.restoreId === entry.id}
										onHoverRestore={(restoreId, sourceId) =>
											setHover(
												restoreId && sourceId
													? { restoreId, sourceId }
													: null,
											)
										}
										onRestore={onRestore}
									/>
								</motion.div>
							))}
						</AnimatePresence>
					</div>
				)}
			</div>
		</div>
	);
};
