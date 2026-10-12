import { ContextMenu } from "@radix-ui/themes";
import { atom, useAtomValue } from "jotai";
import { useSetImmerAtom } from "jotai-immer";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
	copyTimelineFromMain,
	findMainLineIndex,
} from "$/modules/lyric-editor/utils/follow-main-timeline";
import { lyricLinesAtom, selectedLinesAtom } from "$/states/main";
import { type LyricLine, newLyricLine, newLyricWord } from "$/types/ttml";

const selectedLinesSizeAtom = atom((get) => get(selectedLinesAtom).size);

function canEnableFollow(lines: LyricLine[], lineIndex: number): boolean {
	const line = lines[lineIndex];
	if (!line || (!line.isBG && !line.isDuet)) return false;
	const mainIndex = findMainLineIndex(lines, lineIndex);
	if (mainIndex === null) return false;
	const main = lines[mainIndex];
	if (!main) return false;
	return line.words.length === main.words.length;
}

export const LyricLineMenu = ({ lineIndex, syncMode = false}: { lineIndex: number; syncMode?: boolean; }) => {
	const { t } = useTranslation();

	const selectedLinesSize = useAtomValue(selectedLinesSizeAtom);
	const selectedLines = useAtomValue(selectedLinesAtom);
	const editLyricLines = useSetImmerAtom(lyricLinesAtom);

	const lineObjs = useAtomValue(lyricLinesAtom);
	const selectedLineObjs = lineObjs.lyricLines.filter((line) =>
		selectedLines.has(line.id),
	);
	const followCandidates = selectedLineObjs.filter(
		(line) => line.isBG || line.isDuet,
	);
	const clickedLine = lineObjs.lyricLines[lineIndex];
	const clickedCanFollow = canEnableFollow(lineObjs.lyricLines, lineIndex);
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
	const [FollowChecked, setFollowChecked] = React.useState(() => {
		if (syncMode) {
			const clicked = lineObjs.lyricLines[lineIndex];
			return Boolean(
				clicked &&
					(clicked.isBG || clicked.isDuet) &&
					clicked.followMainTimeline,
			);
		}
		if (followCandidates.length === 0) return false;
		if (followCandidates.every((line) => line.followMainTimeline)) return true;
		else if (followCandidates.every((line) => !line.followMainTimeline))
			return false;
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
	function followOnCheck(checked: boolean) {
		setFollowChecked(checked);
		editLyricLines((state) => {
			if (syncMode) {
				applyFollowFlag(state.lyricLines, lineIndex, checked);
				return;
			}
			state.lyricLines.forEach((line, index) => {
				if (!line.isBG && !line.isDuet) return;
				if (!selectedLines.has(line.id)) return;
				applyFollowFlag(state.lyricLines, index, checked);
			});
		});
	}

function applyFollowFlag(lines: LyricLine[], index: number, checked: boolean) {
	const line = lines[index];
	if (!line || (!line.isBG && !line.isDuet)) return;
	if (checked) {
		const mainIndex = findMainLineIndex(lines, index);
		if (mainIndex === null) return;
		const mainLine = lines[mainIndex];
		if (!mainLine) return;
		// 分词数量必须与主歌词行完全一致才能启用
		if (line.words.length !== mainLine.words.length) return;
		copyTimelineFromMain(line, mainLine);
		line.followMainTimeline = true;
	} else {
		line.followMainTimeline = false;
	}
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
			<ContextMenu.CheckboxItem
				checked={FollowChecked}
				onCheckedChange={followOnCheck}
				disabled={
					syncMode
						? !clickedCanFollow
						: !selectedLineObjs.some((line) =>
								canEnableFollow(
									lineObjs.lyricLines,
									lineObjs.lyricLines.indexOf(line),
								),
							)
				}
			>
				{t("contextMenu.syncWithMainTimeline", "与主歌词时间轴相同")}
			</ContextMenu.CheckboxItem>
			<ContextMenu.Separator />
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
};
