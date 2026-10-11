import { ContextMenu } from "@radix-ui/themes";
import { atom, useAtomValue } from "jotai";
import { useSetImmerAtom } from "jotai-immer";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { lyricLinesAtom, selectedLinesAtom } from "$/states/main";
import { type LyricLine, newLyricLine, newLyricWord, type LyricWord } from "$/types/ttml";

const selectedLinesSizeAtom = atom((get) => get(selectedLinesAtom).size);

function findMainLineIndex(lines: LyricLine[], index: number): number | null {
	for (let i = index - 1; i >= 0; i--) {if (!lines[i].isBG && !lines[i].isDuet) return i;}
	return null;
}

function remapWordTimeline(word: LyricWord, newStart: number, newEnd: number) {
	const oldStart = word.startTime;
	const oldEnd = word.endTime;
	word.startTime = newStart;
	word.endTime = newEnd;
	if (!word.ruby || word.ruby.length === 0) return;
	const oldSpan = oldEnd - oldStart;
	if (oldSpan > 0) {
		for (const kana of word.ruby) {
			kana.startTime =
				newStart + ((kana.startTime - oldStart) / oldSpan) * (newEnd - newStart);
			kana.endTime =
				newStart + ((kana.endTime - oldStart) / oldSpan) * (newEnd - newStart);
		}
	} else {
		const step = (newEnd - newStart) / word.ruby.length;
		word.ruby.forEach((kana, i) => {
			kana.startTime = newStart + i * step;
			kana.endTime = newStart + (i + 1) * step;
		});
	}
}

function copyTimelineFromMain(target: LyricLine, main: LyricLine) {
	target.startTime = main.startTime;
	target.endTime = main.endTime;
	delete target.endTimeLink;
	if (target.words.length === 0) return;
	if (target.words.length === main.words.length) {
		target.words.forEach((word, i) => {
			remapWordTimeline(word, main.words[i].startTime, main.words[i].endTime);
		});
		return;
	}
	const firstStart = target.words[0].startTime;
	const lastEnd = target.words[target.words.length - 1].endTime;
	const oldSpan = lastEnd - firstStart;
	const mainSpan = main.endTime - main.startTime;
	if (oldSpan > 0) {
		const scale = mainSpan / oldSpan;
		for (const word of target.words) {
			remapWordTimeline(
				word,
				main.startTime + (word.startTime - firstStart) * scale,
				main.startTime + (word.endTime - firstStart) * scale,
			);
		}
	} else {
		const step = mainSpan / target.words.length;
		target.words.forEach((word, i) => {
			remapWordTimeline(
				word,
				main.startTime + i * step,
				main.startTime + (i + 1) * step,
			);
		});
	}
}

export const LyricLineMenu = ({ lineIndex }: { lineIndex: number }) => {
	const { t } = useTranslation();

	const selectedLinesSize = useAtomValue(selectedLinesSizeAtom);
	const selectedLines = useAtomValue(selectedLinesAtom);
	const editLyricLines = useSetImmerAtom(lyricLinesAtom);

	const lineObjs = useAtomValue(lyricLinesAtom);
	const selectedLineObjs = lineObjs.lyricLines.filter((line) =>
		selectedLines.has(line.id),
	);
	const [Bgchecked, setBgChecked] = React.useState(() => {
		if (selectedLineObjs.every((line) => line.isBG)) return true;
		else if (selectedLineObjs.every((line) => !line.isBG)) return false;
		else return "indeterminate" as const;
	});
	const [DuetChecked, setDuetChecked] = React.useState(() => {
		if (selectedLineObjs.every((line) => line.isDuet)) return true;
		else if (selectedLineObjs.every((line) => !line.isDuet)) return false;
		else return "indeterminate" as const;
	});
	const combineEnabled = (() => {
		if (selectedLinesSize < 2) return null;
		const lineIdxs = lineObjs.lyricLines
			.filter((line) => selectedLines.has(line.id))
			.map((line) => lineObjs.lyricLines.indexOf(line));
		const minIdx = Math.min(...lineIdxs);
		const maxIdx = Math.max(...lineIdxs);
		if (lineIdxs.length !== maxIdx - minIdx + 1) return null;
		for (let i = minIdx; i <= maxIdx; i++)
			if (!lineIdxs.includes(i)) return null;
		return { minIdx, maxIdx };
	})();
	const syncWithMainTimelineEnabled = (() => {
		for (const line of selectedLineObjs) {
			if (!line.isBG && !line.isDuet) continue;
			const index = lineObjs.lyricLines.indexOf(line);
			if (index === -1) continue;
			if (findMainLineIndex(lineObjs.lyricLines, index) !== null) return true;
		}
		return false;
	})();

	function bgOnCheck(checked: boolean) {
		setBgChecked(checked);
		editLyricLines((state) => {
			const lines = state.lyricLines.filter((line) =>
				selectedLines.has(line.id),
			);
			for (const line of lines) line.isBG = checked;
		});
	}
	function duetOnCheck(checked: boolean) {
		setDuetChecked(checked);
		editLyricLines((state) => {
			const lines = state.lyricLines.filter((line) =>
				selectedLines.has(line.id),
			);
			for (const line of lines) line.isDuet = checked;
		});
	}

	return (
		<>
			<ContextMenu.CheckboxItem checked={Bgchecked} onCheckedChange={bgOnCheck}>
				{t("contextMenu.bgLyric", "背景歌词")}
			</ContextMenu.CheckboxItem>
			<ContextMenu.CheckboxItem
				checked={DuetChecked}
				onCheckedChange={duetOnCheck}
			>
				{t("contextMenu.duetLyric", "对唱歌词")}
			</ContextMenu.CheckboxItem>
			<ContextMenu.Separator />
			<ContextMenu.Item
				onSelect={syncWithMainTimeline}
				disabled={!syncWithMainTimelineEnabled}
			>
				{t("contextMenu.syncWithMainTimeline", "与主歌词时间轴相同")}
			</ContextMenu.Item>
			<ContextMenu.Item
				onSelect={() => {
					editLyricLines((state) => {
						state.lyricLines.splice(lineIndex, 0, newLyricLine());
					});
				}}
			>
				{t("contextMenu.insertLineBefore", "在前插入空行")}
			</ContextMenu.Item>
			<ContextMenu.Item
				onSelect={() => {
					editLyricLines((state) => {
						state.lyricLines.splice(lineIndex + 1, 0, newLyricLine());
					});
				}}
			>
				{t("contextMenu.insertLineAfter", "在后插入空行")}
			</ContextMenu.Item>
			<ContextMenu.Item onSelect={copyLines} disabled={selectedLinesSize === 0}>
				{t("contextMenu.copyLine", {
					count: selectedLinesSize,
					defaultValue: "复制行",
				})}
			</ContextMenu.Item>
			<ContextMenu.Item onSelect={combineLines} disabled={!combineEnabled}>
				{t("contextMenu.combineLine", "合并行")}
			</ContextMenu.Item>
			<ContextMenu.Item
				onSelect={() => {
					editLyricLines((state) => {
						if (selectedLinesSize === 0) {
							state.lyricLines.splice(lineIndex, 1);
						} else {
							state.lyricLines = state.lyricLines.filter(
								(line) => !selectedLines.has(line.id),
							);
						}
					});
				}}
			>
				{t("contextMenu.deleteLine", {
					count: selectedLinesSize,
					defaultValue: "删除行",
				})}
			</ContextMenu.Item>
		</>
	);

	function combineLines() {
		editLyricLines((state) => {
			if (!combineEnabled) return;
			const { minIdx, maxIdx } = combineEnabled;
			const target = state.lyricLines[minIdx];
			for (let i = minIdx + 1; i <= maxIdx; i++) {
				const line = state.lyricLines[i];
				target.words.push(...line.words);
			}
			target.endTime = state.lyricLines[maxIdx].endTime;
			state.lyricLines.splice(minIdx + 1, maxIdx - minIdx);
		});
	}

	function copyLines() {
		editLyricLines((state) => {
			state.lyricLines = state.lyricLines.flatMap((line) => {
				if (!selectedLines.has(line.id)) return line;
				const newLine: LyricLine = {
					...line,
					id: newLyricLine().id,
					words: line.words.map((word) => ({
						...word,
						id: newLyricWord().id,
					})),
				};
				return [line, newLine];
			});
		});
	}

	function syncWithMainTimeline() {
		editLyricLines((state) => {
			state.lyricLines.forEach((line, index) => {
				if (!line.isBG && !line.isDuet) return;
				if (!selectedLines.has(line.id)) return;
				const mainIndex = findMainLineIndex(state.lyricLines, index);
				if (mainIndex === null) return;
				const mainLine = state.lyricLines[mainIndex];
				if (!mainLine) return;
				copyTimelineFromMain(line, mainLine);
			});
		});
	}
};
