import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
} from "$/states/main.ts";
import { globalStore } from "$/states/store.ts";
import type { LyricLine, TTMLLyric } from "$/types/ttml";

/**
 * 歌词历史记录（git 风格版本线）
 *
 * 记录人工或 AI 对 TTML 歌词的每一次更改（防抖合并连续输入），
 * 每条记录保存完整快照，可随时还原到任意一次更改时的歌词。
 *
 * 工作方式：
 * - AI 工具 / 还原操作在修改后立即调用 recordHistory 精确记录
 * - 人工编辑由订阅 lyricLinesAtom 的防抖跟踪器自动记录（启发式描述）
 * - lastRecordedJSON 保证同一次更改不会被记录两次
 *
 * git 类比：
 * - 更改（human/ai/load）= 主线上的提交
 * - 还原（restore）= revert 提交，restoreOf 指向被还原的版本，
 *   面板上用曲线把两者连起来（类似 git graph 的分支线）
 */

export type HistorySource = "human" | "ai" | "restore" | "load";

export interface HistoryEntry {
	id: string;
	/** 更改发生的时间戳 (ms) */
	time: number;
	/** 更改来源 */
	source: HistorySource;
	/** 更改描述 */
	description: string;
	/** 更改后的完整歌词快照 */
	snapshot: TTMLLyric;
	lineCount: number;
	wordCount: number;
	/** 短版本号（类似 git 短哈希，按序号生成，稳定且可读） */
	code: string;
	/** 还原操作指向的源版本 id（仅 source === "restore" 时存在） */
	restoreOf?: string;
}

/** 历史记录条数上限（可在面板中调整，持久化保存） */
export const historyMaxEntriesAtom = atomWithStorage<number>(
	"amll.history.maxEntries",
	100,
	undefined,
	// 挂载时同步读取存储值，避免首次渲染读到默认值
	{ getOnInit: true },
);

export const MAX_HISTORY_LIMIT = 500;
export const MIN_HISTORY_LIMIT = 20;

/** 人工编辑停止多少毫秒后记录一条历史 */
const HUMAN_DEBOUNCE_MS = 700;

export const historyEntriesAtom = atom<HistoryEntry[]>([]);

/** 面板是否需要自动滚动到最新记录（有新记录时） */
export const historyNewCountAtom = atom(0);

let entrySeq = 0;
const nextEntryId = () =>
	`hist-${Date.now().toString(36)}-${(entrySeq++).toString(36)}`;

/** git 风格短版本号：序号转 36 进制，补齐 3 位 */
const entryCode = (seq: number) => seq.toString(36).padStart(3, "0").slice(-3);

let lastRecordedJSON = "";
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let trackingStarted = false;

const cloneLyric = (lyric: TTMLLyric): TTMLLyric => structuredClone(lyric);

const serializeLyric = (lyric: TTMLLyric): string => JSON.stringify(lyric);

const countWords = (lines: LyricLine[]) =>
	lines.reduce((sum, line) => sum + line.words.length, 0);

/** 将一个来源标签转换为用户可读文本 */
export const getHistorySourceLabel = (source: HistorySource): string => {
	switch (source) {
		case "human":
			return "手动编辑";
		case "ai":
			return "AI 操作";
		case "restore":
			return "还原";
		case "load":
			return "载入";
	}
};

/** 按当前上限裁剪记录（保留最新的） */
const trimEntries = (entries: HistoryEntry[]): HistoryEntry[] => {
	const max = globalStore.get(historyMaxEntriesAtom);
	if (entries.length <= max) return entries;
	return entries.slice(entries.length - max);
};

/**
 * 记录一条历史（内部使用，会同步更新 lastRecordedJSON）
 */
function pushEntry(
	source: HistorySource,
	description: string,
	restoreOf?: string,
) {
	const current = globalStore.get(lyricLinesAtom);
	const snapshot = cloneLyric(current);
	lastRecordedJSON = serializeLyric(current);
	entrySeq++;
	const entry: HistoryEntry = {
		id: nextEntryId(),
		time: Date.now(),
		source,
		description,
		snapshot,
		lineCount: snapshot.lyricLines.length,
		wordCount: countWords(snapshot.lyricLines),
		code: entryCode(entrySeq),
		restoreOf,
	};
	globalStore.set(historyEntriesAtom, (prev) => trimEntries([...prev, entry]));
	globalStore.set(historyNewCountAtom, (n) => n + 1);
	return entry;
}

/**
 * 记录一条 AI 操作历史（AI 工具修改歌词后调用）
 */
export const recordAIHistory = (description: string) => {
	pushEntry("ai", description);
};

/**
 * 记录载入文档历史（导入/新建时调用，可选）
 */
export const recordLoadHistory = (description: string) => {
	pushEntry("load", description);
};

/**
 * 生成两个快照之间的变更描述（启发式 diff）
 */
function describeChange(prev: TTMLLyric, next: TTMLLyric): string {
	const prevIds = new Set(prev.lyricLines.map((l) => l.id));
	const nextIds = new Set(next.lyricLines.map((l) => l.id));
	const added = next.lyricLines.filter((l) => !prevIds.has(l.id)).length;
	const removedCount = prev.lyricLines.filter((l) => !nextIds.has(l.id)).length;

	// 绝大多数行 ID 都变了 → 视为载入了新文档
	if (
		next.lyricLines.length > 0 &&
		added >= Math.max(3, Math.floor(next.lyricLines.length * 0.7))
	) {
		return `载入歌词文档（${next.lyricLines.length} 行）`;
	}

	let textChanged = 0;
	let timeChanged = 0;
	let wordCountChanged = 0;
	let rubyAdded = 0;
	let rubyRemoved = 0;
	let romanChanged = 0;
	let translationChanged = 0;
	let movedLines = 0;

	const prevIndexById = new Map(
		prev.lyricLines.map((l, i) => [l.id, i] as const),
	);
	next.lyricLines.forEach((line, index) => {
		const prevIndex = prevIndexById.get(line.id);
		if (prevIndex === undefined) return;
		if (prevIndex !== index) movedLines++;
		const prevLine = prev.lyricLines[prevIndex];

		const prevText = prevLine.words.map((w) => w.word).join("");
		const nextText = line.words.map((w) => w.word).join("");
		if (prevText !== nextText) textChanged++;
		if (prevLine.words.length !== line.words.length) wordCountChanged++;

		if (
			Math.abs(prevLine.startTime - line.startTime) > 1 ||
			Math.abs(prevLine.endTime - line.endTime) > 1
		) {
			timeChanged++;
		} else {
			// 行时间没变时再细看词时间
			const wordsChanged = line.words.some((w, i) => {
				const pw = prevLine.words[i];
				if (!pw || pw.id !== w.id) return false;
				return (
					Math.abs(pw.startTime - w.startTime) > 1 ||
					Math.abs(pw.endTime - w.endTime) > 1
				);
			});
			if (wordsChanged) timeChanged++;
		}

		const prevRuby = prevLine.words.filter(
			(w) => w.ruby && w.ruby.length > 0,
		).length;
		const nextRuby = line.words.filter(
			(w) => w.ruby && w.ruby.length > 0,
		).length;
		if (nextRuby > prevRuby) rubyAdded += nextRuby - prevRuby;
		if (prevRuby > nextRuby) rubyRemoved += prevRuby - nextRuby;

		if (prevLine.romanLyric !== line.romanLyric) romanChanged++;
		if (prevLine.translatedLyric !== line.translatedLyric) translationChanged++;
	});

	const parts: string[] = [];
	if (added > 0 && removedCount > 0)
		parts.push(`增删行 ${added}/${removedCount}`);
	else if (added > 0) parts.push(`新增 ${added} 行`);
	else if (removedCount > 0) parts.push(`删除 ${removedCount} 行`);
	if (textChanged > 0) parts.push(`修改 ${textChanged} 行文本`);
	else if (wordCountChanged > 0)
		parts.push(`合并/拆分音节 ${wordCountChanged} 行`);
	if (rubyAdded > 0) parts.push(`假名注音 +${rubyAdded}`);
	else if (rubyRemoved > 0) parts.push(`移除假名 ${rubyRemoved}`);
	if (romanChanged > 0) parts.push(`修改音译 ${romanChanged} 行`);
	if (translationChanged > 0) parts.push(`修改翻译 ${translationChanged} 行`);
	if (timeChanged > 0) parts.push(`调整时间 ${timeChanged} 行`);
	if (movedLines > 0 && parts.length === 0)
		parts.push(`调整行顺序 ${movedLines} 行`);

	const metaChanged =
		JSON.stringify(prev.metadata) !== JSON.stringify(next.metadata);
	if (metaChanged) parts.push("修改元数据");

	if (parts.length === 0) parts.push("内容微调");
	return parts.slice(0, 3).join(" · ");
}

/**
 * 还原到指定历史版本
 *
 * 还原本身也会记录一条 revert 类型的历史（restoreOf 指向源版本），
 * Ctrl+Z 依旧可撤销还原
 */
export const restoreHistoryEntryAtom = atom(
	null,
	(get, set, entryId: string) => {
		const entry = get(historyEntriesAtom).find((e) => e.id === entryId);
		if (!entry) return;
		const snapshot = cloneLyric(entry.snapshot);
		set(lyricLinesAtom, snapshot);
		set(selectedLinesAtom, new Set());
		set(selectedWordsAtom, new Set());
		const timeLabel = new Date(entry.time).toLocaleTimeString();
		pushEntry(
			"restore",
			`还原到 ${entry.code}（${timeLabel}，${entry.description}）`,
			entry.id,
		);
	},
);

/** 清空历史记录 */
export const clearHistoryAtom = atom(null, (_get, set) => {
	set(historyEntriesAtom, []);
});

/** 上限变化时立即裁剪（由面板订阅触发） */
export const applyHistoryLimitAtom = atom(null, (_get, set, max: number) => {
	set(historyEntriesAtom, (prev) =>
		prev.length > max ? prev.slice(prev.length - max) : prev,
	);
});

/**
 * 启动自动历史跟踪（App 挂载时调用一次）
 *
 * 订阅 lyricLinesAtom，人工编辑停止 HUMAN_DEBOUNCE_MS 毫秒后记录一条历史；
 * 已由 recordAIHistory / restore 等显式记录过的状态不会重复记录。
 */
export function initHistoryTracking() {
	if (trackingStarted) return;
	trackingStarted = true;

	// 初始基线：页面加载时的歌词状态（空文档不记录）
	const initial = globalStore.get(lyricLinesAtom);
	if (initial.lyricLines.length > 0) {
		lastRecordedJSON = serializeLyric(initial);
		// 页面刷新后无法区分，统一视为载入
		pushEntry("load", `载入歌词文档（${initial.lyricLines.length} 行）`);
	} else {
		lastRecordedJSON = serializeLyric(initial);
	}

	globalStore.sub(lyricLinesAtom, () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			const current = globalStore.get(lyricLinesAtom);
			const currentJSON = serializeLyric(current);
			if (currentJSON === lastRecordedJSON) return;
			// AI / 还原已经记录过中间态，这里只补记遗漏的尾部变化
			let prev: TTMLLyric | null = null;
			try {
				prev = JSON.parse(lastRecordedJSON) as TTMLLyric;
			} catch {
				prev = null;
			}
			const description = prev
				? describeChange(prev, current)
				: `载入歌词文档（${current.lyricLines.length} 行）`;
			pushEntry("human", description);
		}, HUMAN_DEBOUNCE_MS);
	});
}

/** 供测试与外部模块查询最近一条历史 */
export const getLastHistoryEntry = () => {
	const entries = globalStore.get(historyEntriesAtom);
	return entries.length > 0 ? entries[entries.length - 1] : null;
};
