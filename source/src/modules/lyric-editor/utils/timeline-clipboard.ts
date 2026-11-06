import type { LyricLine, LyricWord } from "$/types/ttml";

export type RubyTime = { startTime: number; endTime: number };

export type TimelineEntry = {
	startTime: number;
	endTime: number;
	ruby?: RubyTime[];
};

export type TimelineClipboard = {
	mode: "relative" | "absolute";
	entries: TimelineEntry[];
};

export function buildRelativeClipboard(words: LyricWord[]): TimelineClipboard {
	const baseStart = words.length === 0 ? 0 : words[0].startTime;
	return {
		mode: "relative",
		entries: words.map((word) => {
			const entry: TimelineEntry = {
				startTime: word.startTime - baseStart,
				endTime: word.endTime - baseStart,
			};
			if (word.ruby) {
				entry.ruby = word.ruby.map((item) => ({
					startTime: item.startTime - baseStart,
					endTime: item.endTime - baseStart,
				}));
			}
			return entry;
		}),
	};
}

export function buildAbsoluteClipboard(words: LyricWord[]): TimelineClipboard {
	return {
		mode: "absolute",
		entries: words.map((word) => {
			const entry: TimelineEntry = {
				startTime: word.startTime,
				endTime: word.endTime,
			};
			if (word.ruby) {
				entry.ruby = word.ruby.map((item) => ({
					startTime: item.startTime,
					endTime: item.endTime,
				}));
			}
			return entry;
		}),
	};
}

export function applyClipboardToWord(
	word: LyricWord,
	entry: TimelineEntry,
	anchorStart: number,
	mode: TimelineClipboard["mode"],
): boolean {
	const oldStart = word.startTime;
	const oldEnd = word.endTime;
	const oldRuby = word.ruby?.map((item) => ({
		startTime: item.startTime,
		endTime: item.endTime,
	}));
	let newStart =
		mode === "relative" ? anchorStart + entry.startTime : entry.startTime;
	let newEnd = mode === "relative" ? anchorStart + entry.endTime : entry.endTime;
	newStart = Math.max(0, newStart);
	newEnd = Math.max(0, newEnd);
	word.startTime = newStart;
	word.endTime = newEnd;
	if (entry.ruby && entry.ruby.length > 0 && word.ruby && word.ruby.length > 0) {
		const count = Math.min(entry.ruby.length, word.ruby.length);
		for (let i = 0; i < count; i++) {
			const src = entry.ruby[i];
			const rubyStart =
				mode === "relative" ? anchorStart + src.startTime : src.startTime;
			const rubyEnd =
				mode === "relative" ? anchorStart + src.endTime : src.endTime;
			word.ruby[i].startTime = Math.max(0, rubyStart);
			word.ruby[i].endTime = Math.max(0, rubyEnd);
		}
	}
	if (oldStart !== newStart || oldEnd !== newEnd) return true;
	if (!oldRuby || !word.ruby) return false;
	return word.ruby.some(
		(item, index) =>
			item.startTime !== oldRuby[index].startTime ||
			item.endTime !== oldRuby[index].endTime,
	);
}

export function adjustLineTimeAfterPaste(
	line: LyricLine,
	oldLineStart: number,
	oldLineEnd: number,
	oldFirstWordStart: number,
	oldLastWordEnd: number,
	pastedWords: LyricWord[],
) {
	if (pastedWords.length === 0) return;
	const firstWord = line.words[0];
	const lastWord = line.words[line.words.length - 1];
	const hasFirst = firstWord ? pastedWords.includes(firstWord) : false;
	const hasLast = lastWord ? pastedWords.includes(lastWord) : false;
	const minStart = Math.min(...pastedWords.map((w) => w.startTime));
	const maxEnd = Math.max(...pastedWords.map((w) => w.endTime));
	if (line.startTime > minStart) {
		line.startTime = minStart;
	} else if (hasFirst && firstWord && line.startTime === oldFirstWordStart && firstWord.startTime > oldFirstWordStart) {
		line.startTime = firstWord.startTime;
	}
	if (line.endTime < maxEnd) {
		line.endTime = maxEnd;
	} else if (hasLast && lastWord && line.endTime === oldLastWordEnd && lastWord.endTime < oldLastWordEnd) {
		line.endTime = lastWord.endTime;
	}
}

export function collectWordsInOrder(
	lines: LyricLine[],
	selectedIds: Set<string>,
): LyricWord[] {
	const result: LyricWord[] = [];
	for (const line of lines) {
		for (const word of line.words) {
			if (selectedIds.has(word.id)) result.push(word);
		}
	}
	return result;
}
