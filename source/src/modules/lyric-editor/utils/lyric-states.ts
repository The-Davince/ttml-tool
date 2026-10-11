import { type createStore, useAtomValue } from "jotai";
import { useMemo } from "react";
import {
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
} from "$/states/main.ts";
import type { LyricLine, LyricWord, LyricWordBase } from "$/types/ttml";

export interface LineLocationResult {
	lines: LyricLine[];
	line: LyricLine;
	lineIndex: number;
}

export interface LineAndWordLocationResult extends LineLocationResult {
	word: LyricWord;
	wordIndex: number;
	rubyIndex?: number;
	rubyWord?: LyricWordBase;
	syncIndex: number;
	syncId: string;
	isFirstWord: boolean;
	isLastWord: boolean;
}

export interface SyncWordUnit {
	id: string;
	word: LyricWord;
	wordIndex: number;
	rubyIndex?: number;
	rubyWord?: LyricWordBase;
}

/**
 * 获取一个单词在打轴界面使用的开始时间
 *
 * 带假名的单词以假名时间的并集为权威时间（AMLL 渲染以假名时间为准），
 * 仅当假名时间全为 0（尚未分割）时回退到单词自身的时间
 */
export const getWordSyncStartTime = (word: LyricWord): number => {
	const ruby = word.ruby;
	if (!ruby || ruby.length === 0) return word.startTime;
	const minStart = Math.min(...ruby.map((r) => r.startTime));
	if (minStart > 0) return minStart;
	if (word.startTime > 0) return word.startTime;
	return minStart;
};

/**
 * 获取一个单词在打轴界面使用的结束时间（与 getWordSyncStartTime 对应）
 */
export const getWordSyncEndTime = (word: LyricWord): number => {
	const ruby = word.ruby;
	if (!ruby || ruby.length === 0) return word.endTime;
	const maxEnd = Math.max(...ruby.map((r) => r.endTime));
	if (maxEnd > 0) return maxEnd;
	if (word.endTime > 0) return word.endTime;
	return maxEnd;
};

export const buildRubySelectionId = (wordId: string, rubyIndex: number) =>
	`${wordId}-ruby-${rubyIndex}`;

export const parseRubySelectionId = (id: string) => {
	const match = id.match(/^(.*)-ruby-(\d+)$/);
	if (!match) return;
	return {
		wordId: match[1],
		rubyIndex: Number.parseInt(match[2], 10),
	};
};

export const getSyncUnitsForLine = (line: LyricLine): SyncWordUnit[] =>
	line.words.flatMap((word, wordIndex) => {
		// 带假名的单词在打轴界面合并为一张卡片（假名拼合显示在字上方），
		// 因此同步单元也使用词级粒度，与卡片一一对应；
		// 假名的精细时间调整可在编辑模式的注音编辑器中进行
		return [
			{
				id: word.id,
				word,
				wordIndex,
			},
		];
	});

export const getSynchronizableUnits = (line: LyricLine) =>
	getSyncUnitsForLine(line).filter((unit) => {
		const wordText = unit.word.word.trim();
		const rubyText = (unit.word.ruby ?? [])
			.map((rubyWord) => rubyWord.word)
			.join("");
		return wordText.length > 0 || rubyText.trim().length > 0;
	});

export const getFirstSynchronizableUnit = (line: LyricLine) =>
	getSynchronizableUnits(line)[0];

export const getLastSynchronizableUnit = (line: LyricLine) => {
	const units = getSynchronizableUnits(line);
	return units[units.length - 1];
};

export function getCurrentLineLocation(
	store: ReturnType<typeof createStore>,
): LineLocationResult | undefined {
	const lyricLines = store.get(lyricLinesAtom).lyricLines;
	const selectedLineId = [...store.get(selectedLinesAtom)][0]; // 进入打轴模式下一般不会出现多选的情况
	if (!selectedLineId) return;
	const lyricLine = lyricLines.findIndex((line) => line.id === selectedLineId);
	if (lyricLine === -1) return;
	return {
		lines: lyricLines,
		line: lyricLines[lyricLine],
		lineIndex: lyricLine,
	};
}

export function getCurrentLocation(
	store: ReturnType<typeof createStore>,
): LineAndWordLocationResult | undefined {
	const lyricLines = store.get(lyricLinesAtom).lyricLines;
	const selectedLineId = [...store.get(selectedLinesAtom)][0]; // 进入打轴模式下一般不会出现多选的情况
	if (!selectedLineId) return;
	const lyricLine = lyricLines.findIndex((line) => line.id === selectedLineId);
	if (lyricLine === -1) return;
	const selectedWordId = [...store.get(selectedWordsAtom)][0];
	if (!selectedWordId) return;
	const line = lyricLines[lyricLine];
	const syncUnits = getSynchronizableUnits(line);
	let syncIndex = syncUnits.findIndex((unit) => unit.id === selectedWordId);
	if (syncIndex === -1) {
		const parsed = parseRubySelectionId(selectedWordId);
		if (parsed) {
			syncIndex = syncUnits.findIndex(
				(unit) =>
					unit.word.id === parsed.wordId && unit.rubyIndex === parsed.rubyIndex,
			);
		} else {
			syncIndex = syncUnits.findIndex(
				(unit) => unit.word.id === selectedWordId,
			);
		}
	}
	if (syncIndex === -1) return;
	const targetUnit = syncUnits[syncIndex];
	if (!targetUnit) return;
	const isFirstWord = syncIndex === 0;
	const isLastWord = syncIndex === syncUnits.length - 1;
	return {
		lines: lyricLines,
		line,
		lineIndex: lyricLine,
		word: targetUnit.word,
		wordIndex: targetUnit.wordIndex,
		rubyIndex: targetUnit.rubyIndex,
		rubyWord: targetUnit.rubyWord,
		syncIndex,
		syncId: targetUnit.id,
		isFirstWord,
		isLastWord,
	};
}

export function useCurrentLocation(): LineAndWordLocationResult | undefined {
	const lyrics = useAtomValue(lyricLinesAtom);
	const selectedLines = useAtomValue(selectedLinesAtom);
	const selectedWords = useAtomValue(selectedWordsAtom);
	const result = useMemo(() => {
		const lyricLine = lyrics.lyricLines.findIndex((line) =>
			selectedLines.has(line.id),
		);
		if (lyricLine === -1) return;
		const line = lyrics.lyricLines[lyricLine];
		const syncUnits = getSynchronizableUnits(line);
		let syncIndex = syncUnits.findIndex((unit) => selectedWords.has(unit.id));
		if (syncIndex === -1) {
			const selectedWordId = [...selectedWords][0];
			if (!selectedWordId) return;
			const parsed = parseRubySelectionId(selectedWordId);
			if (parsed) {
				syncIndex = syncUnits.findIndex(
					(unit) =>
						unit.word.id === parsed.wordId &&
						unit.rubyIndex === parsed.rubyIndex,
				);
			} else {
				syncIndex = syncUnits.findIndex(
					(unit) => unit.word.id === selectedWordId,
				);
			}
		}
		if (syncIndex === -1) return;
		const targetUnit = syncUnits[syncIndex];
		if (!targetUnit) return;
		const isFirstWord = syncIndex === 0;
		const isLastWord = syncIndex === syncUnits.length - 1;
		return {
			lines: lyrics.lyricLines,
			line,
			lineIndex: lyricLine,
			word: targetUnit.word,
			wordIndex: targetUnit.wordIndex,
			rubyIndex: targetUnit.rubyIndex,
			rubyWord: targetUnit.rubyWord,
			syncIndex,
			syncId: targetUnit.id,
			isFirstWord,
			isLastWord,
		};
	}, [lyrics, selectedLines, selectedWords]);
	return result;
}

export const isSynchronizableLine = (line: LyricLine) => !line.ignoreSync;

export function findNextWord(
	lyricLines: LyricLine[],
	lineIndex: number,
	syncIndex: number,
	skipFollowEnabledLines = false,
):
	| {
			unit: SyncWordUnit;
			line: LyricLine;
			lineIndex: number;
			syncIndex: number;
	  }
	| undefined {
	const line = lyricLines[lineIndex];
	if (!line) return;
	const units = getSynchronizableUnits(line);
	const nextUnit = units[syncIndex + 1];
	if (nextUnit) {
		return {
			line,
			lineIndex,
			unit: nextUnit,
			syncIndex: syncIndex + 1,
		};
	}
	const nextLineIndex = lyricLines
		.slice(lineIndex + 1)
		.findIndex((nextLine, offset) => {
			if (!isSynchronizableLine(nextLine) || getSynchronizableUnits(nextLine).length === 0) return false;
			if (!skipFollowEnabledLines) return true;
			return (
				!nextLine.followMainTimeline ||
				lineIndex + 1 + offset === lyricLines.length - 1
			);
		});
	if (nextLineIndex === -1) return;
	const absoluteIndex = lineIndex + 1 + nextLineIndex;
	const nextLine = lyricLines[absoluteIndex];
	if (!nextLine) return;
	const nextLineUnits = getSynchronizableUnits(nextLine);
	const firstUnit = nextLineUnits[0];
	if (!firstUnit) return;
	return {
		line: nextLine,
		lineIndex: absoluteIndex,
		unit: firstUnit,
		syncIndex: 0,
	};
}
