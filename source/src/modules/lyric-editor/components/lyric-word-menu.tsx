import { ContextMenu } from "@radix-ui/themes";
import { type Atom, atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useSetImmerAtom } from "jotai-immer";
import { useTranslation } from "react-i18next";
import { replaceWordDialogAtom, splitWordDialogAtom } from "$/states/dialogs";
import {
	editingWordStateAtom,
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
} from "$/states/main";
import {
	type LyricLine,
	type LyricWord,
	newLyricLine,
	newLyricWord,
} from "$/types/ttml";
import { timelineClipboardAtom } from "$/states/timeline-clipboard";
import { normalizeLineTime } from "../utils/normalize-line-time";
import {
	adjustLineTimeAfterPaste,
	applyClipboardToWord,
	buildAbsoluteClipboard,
	buildRelativeClipboard,
	collectWordsInOrder,
} from "../utils/timeline-clipboard";

const selectedLinesSizeAtom = atom((get) => get(selectedLinesAtom).size);
const selectedWordsSizeAtom = atom((get) => get(selectedWordsAtom).size);

export const LyricWordMenu = ({
	wordIndex,
	wordAtom,
	lineIndex,
}: {
	wordIndex: number;
	wordAtom: Atom<LyricWord>;
	lineIndex: number;
}) => {
	const { t } = useTranslation();

	const store = useStore();
	const selectedWordsSize = useAtomValue(selectedWordsSizeAtom);
	const selectedLinesSize = useAtomValue(selectedLinesSizeAtom);
	const editLyricLines = useSetImmerAtom(lyricLinesAtom);
	const setOpenSplitWordDialog = useSetAtom(splitWordDialogAtom);
	const setOpenReplaceWordDialog = useSetAtom(replaceWordDialogAtom);
	const setEditingWordState = useSetAtom(editingWordStateAtom);
	const word = useAtomValue(wordAtom);
	const clipboard = useAtomValue(timelineClipboardAtom);
	const setClipboard = useSetAtom(timelineClipboardAtom);
	const canPaste = clipboard !== null && clipboard.entries.length > 0;
	const lineObjs = useAtomValue(lyricLinesAtom);

	function buildCopyWords(): LyricWord[] {
		const selectedWords = store.get(selectedWordsAtom);
		if (selectedWords.size > 0) {
			return collectWordsInOrder(lineObjs.lyricLines, selectedWords);
		}
		const target = lineObjs.lyricLines[lineIndex]?.words[wordIndex];
		return target ? [target] : [];
	}

	function pasteToTargets(targetIds: string[]) {
		if (!clipboard || targetIds.length === 0) return;
		editLyricLines((state) => {
			const entries = clipboard.entries;
			const lineByWord = new Map<string, LyricLine>();
			const wordById = new Map<string, LyricWord>();
			for (const line of state.lyricLines) {
				for (const item of line.words) {
					lineByWord.set(item.id, line);
					wordById.set(item.id, item);
				}
			}
			let firstWord: LyricWord | undefined;
			for (const id of targetIds) {
				const found = wordById.get(id);
				if (found) {
					firstWord = found;
					break;
				}
			}
			if (!firstWord) return;
			const anchorStart = firstWord.startTime;
			const affectedLines = new Map<
				LyricLine,
				{ start: number; end: number; first: number; last: number; words: LyricWord[] }
			>();
			for (const line of state.lyricLines) {
				affectedLines.set(line, {
					start: line.startTime,
					end: line.endTime,
					first: line.words[0]?.startTime ?? 0,
					last: line.words[line.words.length - 1]?.endTime ?? 0,
					words: [],
				});
			}
			const count = Math.min(targetIds.length, entries.length);
			for (let i = 0; i < count; i++) {
				const entry = entries[i];
				if (!entry) continue;
				const targetWord = wordById.get(targetIds[i]);
				if (!targetWord) continue;
				const changed = applyClipboardToWord(targetWord, entry, anchorStart, clipboard.mode);
				if (!changed) continue;
				const owner = lineByWord.get(targetWord.id);
				if (owner) affectedLines.get(owner)?.words.push(targetWord);
			}
			for (const line of state.lyricLines) {
				const info = affectedLines.get(line);
				if (!info || info.words.length === 0) continue;
				adjustLineTimeAfterPaste(
					line,
					info.start,
					info.end,
					info.first,
					info.last,
					info.words,
				);
			}
		});
	}

	function collectForwardTargets(full: boolean): string[] {
		if (selectedWordsSize > 1) {
			return collectWordsInOrder(
				lineObjs.lyricLines,
				store.get(selectedWordsAtom),
			).map((item) => item.id);
		}
		if (!full) {
			const target = lineObjs.lyricLines[lineIndex]?.words[wordIndex];
			return target ? [target.id] : [];
		}
		const flat: LyricWord[] = [];
		for (const line of lineObjs.lyricLines) {
			for (const item of line.words) {
				flat.push(item);
			}
		}
		const startIndex = flat.findIndex(
			(item) => item.id === lineObjs.lyricLines[lineIndex]?.words[wordIndex]?.id,
		);
		if (startIndex < 0) return [];
		return flat.slice(startIndex).map((item) => item.id);
	}

	return (
		<>
			<ContextMenu.Item
				disabled={selectedWordsSize !== 1}
				onSelect={() => {
					setEditingWordState({
						wordIndex,
						lineIndex,
						word: word.word,
					});
					setOpenSplitWordDialog(true);
				}}
			>
				{t("contextMenu.splitWord", "拆分单词…")}
			</ContextMenu.Item>
			<ContextMenu.Item
				disabled={selectedWordsSize !== 1}
				onSelect={() => {
					setEditingWordState({
						wordIndex,
						lineIndex,
						word: word.word,
					});
					setOpenReplaceWordDialog(true);
				}}
			>
				{t("contextMenu.replaceWord", "替换单词…")}
			</ContextMenu.Item>
			<ContextMenu.Item
				disabled={!(selectedWordsSize > 1 && selectedLinesSize === 1)}
				onSelect={() => {
					editLyricLines((state) => {
						const selectedWords = store.get(selectedWordsAtom);
						const line = state.lyricLines[lineIndex];
						if (line) {
							const selectedWordsInLine = line.words.filter((w) =>
								selectedWords.has(w.id),
							);

							if (selectedWordsInLine.length > 1) {
								const mergedWord = selectedWordsInLine
									.map((w) => w.word)
									.join("");
								const firstWord = selectedWordsInLine[0];
								const lastWord =
									selectedWordsInLine[selectedWordsInLine.length - 1];
								const firstIndex = line.words.indexOf(firstWord);

								const newWord = newLyricWord();
								newWord.word = mergedWord;
								newWord.startTime = firstWord.startTime;
								newWord.endTime = lastWord.endTime;

								state.lyricLines[lineIndex].words = line.words.filter(
									(w) => !selectedWords.has(w.id),
								);
								if (firstIndex !== -1) {
									state.lyricLines[lineIndex].words.splice(
										firstIndex,
										0,
										newWord,
									);
								}
							}
						}
					});
				}}
			>
				{t("contextMenu.combineWords", "合并单词")}
			</ContextMenu.Item>

			<ContextMenu.Item
				disabled={selectedWordsSize === 0}
				onSelect={() => {
					editLyricLines((state) => {
						const selectedWords = store.get(selectedWordsAtom);
						for (const line of state.lyricLines) {
							const originalLength = line.words.length;
							const filteredWords = line.words.filter(
								(w) => !selectedWords.has(w.id),
							);
							line.words = filteredWords;
							if (originalLength !== filteredWords.length)
								normalizeLineTime(line);
						}
					});
				}}
			>
				{t("contextMenu.deleteWords", {
					count: selectedWordsSize,
					defaultValue: "删除选定单词",
				})}
			</ContextMenu.Item>

			<ContextMenu.Separator />

			<ContextMenu.Item
				disabled={selectedWordsSize !== 1}
				onSelect={() => afterToNewLine()}
			>
				{t("contextMenu.moveFollowingWordToNewLine", "此后单词拆至新行")}
			</ContextMenu.Item>

			<ContextMenu.Item
				disabled={selectedWordsSize === 0}
				onSelect={() => selectedToNewLine()}
			>
				{t("contextMenu.moveWordToNewLine", {
					count: selectedWordsSize,
					defaultValue: "所选单词拆至新行",
				})}
			</ContextMenu.Item>

			<ContextMenu.Separator />
			<ContextMenu.Sub>
				<ContextMenu.SubTrigger>
					{t("contextMenu.copyTimeline", "复制时间轴")}
				</ContextMenu.SubTrigger>
				<ContextMenu.SubContent>
					<ContextMenu.Item
						onSelect={() => {
							const srcWords = buildCopyWords();
							if (srcWords.length > 0) setClipboard(buildRelativeClipboard(srcWords));
						}}
					>
						{t("contextMenu.copyRelativeTimeline", "相对时间轴")}
					</ContextMenu.Item>
					<ContextMenu.Item
						onSelect={() => {
							const srcWords = buildCopyWords();
							if (srcWords.length > 0) setClipboard(buildAbsoluteClipboard(srcWords));
						}}
					>
						{t("contextMenu.copyAbsoluteTimeline", "绝对时间轴")}
					</ContextMenu.Item>
				</ContextMenu.SubContent>
			</ContextMenu.Sub>
			{selectedWordsSize > 1 ? (
				<ContextMenu.Item
					disabled={!canPaste}
					onSelect={() => {
						pasteToTargets(collectForwardTargets(false));
					}}
				>
					{t("contextMenu.pasteTimeline", "粘贴时间轴")}
				</ContextMenu.Item>
			) : (
				<ContextMenu.Sub>
					<ContextMenu.SubTrigger disabled={!canPaste}>
						{t("contextMenu.pasteTimeline", "粘贴时间轴")}
					</ContextMenu.SubTrigger>
					<ContextMenu.SubContent>
						<ContextMenu.Item
							disabled={!canPaste}
							onSelect={() => {
								pasteToTargets(collectForwardTargets(true));
							}}
						>
							{t("contextMenu.pasteForwardFull", "向后完整粘贴")}
						</ContextMenu.Item>
						<ContextMenu.Item
							disabled={!canPaste}
							onSelect={() => {
								pasteToTargets(collectForwardTargets(false));
							}}
						>
							{t("contextMenu.pasteCurrentWord", "只粘贴当前单词")}
						</ContextMenu.Item>
					</ContextMenu.SubContent>
				</ContextMenu.Sub>
			)}
		</>
	);

	function selectedToNewLine() {
		editLyricLines((state) => {
			const selectedWordIds = store.get(selectedWordsAtom);
			const selectedWords: LyricWord[] = [];
			const affectedLines: LyricLine[] = [];
			for (const line of state.lyricLines) {
				const deletedAtBounds =
					line.words.length > 0 &&
					(selectedWordIds.has(line.words[0].id) ||
						selectedWordIds.has(line.words[line.words.length - 1].id));
				line.words = line.words.filter((w) => {
					if (selectedWordIds.has(w.id)) {
						selectedWords.push(w);
						affectedLines.push(line);
						return false;
					}
					return true;
				});
				if (deletedAtBounds) normalizeLineTime(line);
			}
			const newLine = {
				...newLyricLine(),
				isBG: state.lyricLines[lineIndex].isBG,
				isDuet: state.lyricLines[lineIndex].isDuet,
			} as LyricLine;
			newLine.words.push(...selectedWords);
			normalizeLineTime(newLine);
			state.lyricLines.splice(lineIndex + 1, 0, newLine);
		});
	}

	function afterToNewLine() {
		editLyricLines((state) => {
			const line = state.lyricLines[lineIndex];
			if (!line) return;
			const word = line.words[wordIndex];
			if (!word) return;
			if (/^\s*$/.test(word.word) && !word.startTime && !word.endTime)
				line.words.splice(wordIndex, 1);
			const wordsToMove = line.words.splice(wordIndex);
			const newLine = {
				...newLyricLine(),
				isBG: line.isBG,
				isDuet: line.isDuet,
			} as LyricLine;
			newLine.words.push(...wordsToMove);
			normalizeLineTime(line);
			normalizeLineTime(newLine);
			state.lyricLines.splice(lineIndex + 1, 0, newLine);
		});
	}
};
