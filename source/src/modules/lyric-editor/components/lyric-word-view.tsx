/*
 * Copyright 2023-2026 Steve Xiao (stevexmh@qq.com) and contributors.
 *
 * 本源代码文件是属于 AMLL TTML Tool 项目的一部分。
 * This source code file is a part of AMLL TTML Tool project.
 * 本项目的源代码的使用受到 GNU GENERAL PUBLIC LICENSE version 3 许可证的约束，具体可以参阅以下链接。
 * Use of this source code is governed by the GNU GPLv3 license that can be found through the following link.
 *
 * https://github.com/amll-dev/amll-ttml-tool/blob/main/LICENSE
 */

import {
	CutRegular,
	DeleteRegular,
	PaddingLeftRegular,
	PaddingRightRegular,
	SplitVerticalRegular,
	TaskListLtrRegular,
} from "@fluentui/react-icons";
import { ContextMenu, IconButton, TextField } from "@radix-ui/themes";
import classNames from "classnames";
import { type Atom, atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useSetImmerAtom } from "jotai-immer";
import {
	type FC,
	type MouseEvent,
	memo,
	type PropsWithChildren,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LyricLineMenu } from "$/components/Menus/lyric-line-menu.tsx";
import { audioEngine } from "$/modules/audio/audio-engine.ts";
import {
	highlightActiveWordAtom,
	highlightErrorsAtom,
	LayoutMode,
	layoutModeAtom,
	showTimestampsAtom,
	SyncWordDisplayMode,
	syncWordDisplayModeAtom,
} from "$/modules/settings/states/index.ts";
import { visualizeTimestampUpdateAtom } from "$/modules/settings/states/sync.ts";
import { splitWordDialogAtom } from "$/states/dialogs.ts";
import {
	editingWordStateAtom,
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
	showEndTimeAsDurationAtom,
	ToolMode,
	toolModeAtom,
} from "$/states/main.ts";
import { type LyricLine, type LyricWord, newLyricWord } from "$/types/ttml.ts";
import { containsRadicalChar } from "$/utils/detect-radical.ts";
import { msToTimestamp, parseTimespan } from "$/utils/timestamp.ts";
import { RubyEditor } from "../tools/RubyEditor.tsx";
import {
	buildRubySelectionId,
	getWordSyncEndTime,
	getWordSyncStartTime,
} from "../utils/lyric-states.ts";
import {
	detectLineBackflows,
	isWordBackflowing,
} from "../utils/backflow.ts";
import { normalizeLineTime } from "../utils/normalize-line-time.ts";
import styles from "./index.module.css";
import { LyricWordMenu } from "./lyric-word-menu";

const isDraggingAtom = atom(false);

const useWordBlank = (word: string) =>
	useMemo(
		() => word.length === 0 || (word.length > 0 && word.trim().length === 0),
		[word],
	);

const parseRubyShortcut = (value: string) => {
	if (value.endsWith("|")) {
		return {
			word: value.slice(0, -1),
			enableRuby: true,
		};
	}
	return {
		word: value,
		enableRuby: false,
	};
};

const getDisplayWordText = (
	t: (
		key: string,
		defaultValue: string,
		options?: { count?: number },
	) => string,
	word: string,
	isWordBlank: boolean,
) => {
	if (word === "") return t("lyricWordView.empty", "空白");
	if (isWordBlank)
		return t("lyricWordView.spaceCount", "空格 x{count}", {
			count: word.length,
		});
	return word;
};

type LyricWordViewEditProps = {
	wordAtom: Atom<LyricWord>;
	wordIndex: number;
	line: LyricLine;
	lineIndex: number;
};

const LyricWordViewEditSpan = ({
	wordAtom,
	wordIndex,
	line,
	lineIndex,
	className,
	children,
	onDoubleClick,
}: PropsWithChildren<
	LyricWordViewEditProps & {
		className?: string;
		onDoubleClick?: () => void;
	}
>) => {
	const word = useAtomValue(wordAtom);
	const store = useStore();
	const editLyricLines = useSetImmerAtom(lyricLinesAtom);
	const setSelectedLines = useSetImmerAtom(selectedLinesAtom);
	const isWordSelectedAtom = useMemo(
		() => atom((get) => get(selectedWordsAtom).has(get(wordAtom).id)),
		[wordAtom],
	);
	const isWordSelected = useAtomValue(isWordSelectedAtom);
	const selectedWords = useAtomValue(selectedWordsAtom);
	const setSelectedWords = useSetImmerAtom(selectedWordsAtom);
	const toolMode = useAtomValue(toolModeAtom);
	const blockDragRef = useRef(false);

	function onWordSelect(evt: MouseEvent<HTMLSpanElement>) {
		if (evt.ctrlKey || evt.metaKey) {
			setSelectedWords((v) => {
				if (v.has(word.id)) {
					v.delete(word.id);
				} else {
					v.add(word.id);
				}
			});
		} else if (evt.shiftKey) {
			setSelectedWords((v) => {
				if (v.size > 0) {
					let minBoundry = Number.NaN;
					let maxBoundry = Number.NaN;
					line.words.forEach((word, i) => {
						if (v.has(word.id)) {
							if (Number.isNaN(minBoundry)) minBoundry = i;
							if (Number.isNaN(maxBoundry)) maxBoundry = i;

							minBoundry = Math.min(minBoundry, i, wordIndex);
							maxBoundry = Math.max(maxBoundry, i, wordIndex);
						}
					});
					for (let i = minBoundry; i <= maxBoundry; i++) {
						v.add(line.words[i].id);
					}
				} else {
					v.add(word.id);
				}
			});
		} else {
			setSelectedLines((state) => {
				if (!state.has(line.id) || state.size !== 1) {
					state.clear();
					state.add(line.id);
				}
			});
			setSelectedWords((state) => {
				if (!state.has(word.id) || state.size !== 1) {
					state.clear();
					state.add(word.id);
				}
			});
		}
	}

	return (
		<ContextMenu.Root
			onOpenChange={(open) => {
				if (!open) return;
				if (isWordSelected) return;
				setSelectedWords((state) => {
					state.clear();
					state.add(word.id);
				});
				setSelectedLines((state) => {
					state.clear();
					state.add(line.id);
				});
			}}
		>
			<ContextMenu.Trigger>
				<span
					draggable={toolMode === ToolMode.Edit}
					onPointerDown={(evt) => {
						blockDragRef.current =
							(evt.target as HTMLElement | null)?.tagName === "INPUT";
					}}
					onPointerUp={() => {
						blockDragRef.current = false;
					}}
					onDragStart={(evt) => {
						if (blockDragRef.current) {
							blockDragRef.current = false;
							evt.preventDefault();
							evt.stopPropagation();
							return;
						}
						if (!isWordSelected) onWordSelect(evt);
						evt.dataTransfer.effectAllowed = "copyMove";
						evt.dataTransfer.dropEffect = "move";
						store.set(isDraggingAtom, true);
						evt.stopPropagation();
					}}
					onDragEnd={() => {
						store.set(isDraggingAtom, false);
						blockDragRef.current = false;
					}}
					onDragOver={(evt) => {
						if (!store.get(isDraggingAtom)) return;
						if (isWordSelected) return;
						evt.preventDefault();
						evt.dataTransfer.dropEffect = "move";
						const rect = evt.currentTarget.getBoundingClientRect();
						const innerX = evt.clientX - rect.left;
						if (innerX < rect.width / 2) {
							evt.currentTarget.classList.add(styles.dropLeft);
							evt.currentTarget.classList.remove(styles.dropRight);
						} else {
							evt.currentTarget.classList.remove(styles.dropLeft);
							evt.currentTarget.classList.add(styles.dropRight);
						}
						const isCopyingWords = evt.ctrlKey || evt.metaKey;
						evt.dataTransfer.dropEffect = isCopyingWords ? "copy" : "move";
					}}
					onDrop={(evt) => {
						evt.currentTarget.classList.remove(styles.dropLeft);
						evt.currentTarget.classList.remove(styles.dropRight);
						if (!store.get(isDraggingAtom)) return;
						if (isWordSelected) return;

						const rect = evt.currentTarget.getBoundingClientRect();
						const innerX = evt.clientX - rect.left;
						const insertRight = innerX > rect.width / 2;

						const isCopyingWords = evt.ctrlKey || evt.metaKey;
						editLyricLines((state) => {
							const targetLine = state.lyricLines.find(
								({ id }) => id === line.id,
							);
							if (!targetLine) return;
							const targetIndex = targetLine.words.findIndex(
								(w) => w.id === word.id,
							);
							if (targetIndex < 0) return;
							let collectedWords: LyricWord[] = [];
							for (const line of state.lyricLines) {
								const words = line.words.filter((w) => selectedWords.has(w.id));
								collectedWords.push(...words);
								if (!isCopyingWords) {
									const deletedAtBounds =
										line.words.length > 0 &&
										(selectedWords.has(line.words[0].id) ||
											selectedWords.has(line.words[line.words.length - 1].id));
									line.words = line.words.filter(
										(w) => !selectedWords.has(w.id),
									);
									if (deletedAtBounds) normalizeLineTime(line);
								}
							}
							if (isCopyingWords) {
								collectedWords = collectedWords.map((w) => ({
									...w,
									id: newLyricWord().id,
								}));
								setSelectedWords((v) => {
									v.clear();
									for (const w of collectedWords) {
										v.add(w.id);
									}
								});
							}
							const insertPosition = targetIndex + (insertRight ? 1 : 0);
							const insertedAtBounds =
								insertPosition === 0 ||
								insertPosition === targetLine.words.length;
							targetLine.words.splice(insertPosition, 0, ...collectedWords);
							if (insertedAtBounds) normalizeLineTime(targetLine);
						});
					}}
					onDragLeave={(evt) => {
						evt.currentTarget.classList.remove(styles.dropLeft);
						evt.currentTarget.classList.remove(styles.dropRight);
					}}
					className={className}
					onDoubleClick={onDoubleClick}
					onClick={(evt) => {
						evt.stopPropagation();
						evt.preventDefault();
						onWordSelect(evt);
					}}
				>
					{children}
				</span>
			</ContextMenu.Trigger>
			<ContextMenu.Content>
				<LyricWordMenu
					wordAtom={wordAtom}
					wordIndex={wordIndex}
					lineIndex={lineIndex}
				/>
				<LyricLineMenu lineIndex={lineIndex} />
			</ContextMenu.Content>
		</ContextMenu.Root>
	);
};

function WordEditField<F extends keyof LyricWord, V extends LyricWord[F]>({
	wordAtom,
	fieldName,
	formatter,
	parser,
	// textFieldStyle,
	children,
	...other
}: PropsWithChildren<
	{
		wordAtom: Atom<LyricWord>;
		fieldName: F;
		formatter: (v: V) => string;
		parser: (v: string) => V;
		textFieldStyle?: React.CSSProperties;
	} & TextField.RootProps
>) {
	const [fieldInput, setFieldInput] = useState<string | undefined>(undefined);
	const [fieldPlaceholder, setFieldPlaceholder] = useState<string>("");

	const editLyricLines = useSetImmerAtom(lyricLinesAtom);

	const currentValueAtom = useMemo(
		() =>
			atom((get) => {
				const word = get(wordAtom);
				return formatter(word[fieldName] as V);
			}),
		[fieldName, wordAtom, formatter],
	);
	const currentValue = useAtomValue(currentValueAtom);
	const store = useStore();

	const onInputFinished = useCallback(
		(rawValue: string) => {
			try {
				const thisWord = store.get(wordAtom);
				const { word: inputWord, enableRuby } =
					fieldName === "word"
						? parseRubyShortcut(rawValue)
						: { word: rawValue, enableRuby: false };
				const value =
					fieldName === "word"
						? (inputWord as unknown as V)
						: parser(inputWord as string);
				editLyricLines((state) => {
					for (const line of state.lyricLines) {
						for (const word of line.words) {
							if (thisWord.id === word.id) {
								word[fieldName] = value;
								if (fieldName === "word" && enableRuby && !word.ruby) {
									word.ruby = [];
								}
								break;
							}
						}
					}
					return state;
				});
			} catch {
				if (typeof currentValue === "string") setFieldInput(currentValue);
			}
		},
		[wordAtom, store, editLyricLines, currentValue, fieldName, parser],
	);

	useLayoutEffect(() => {
		setFieldInput(currentValue);
		setFieldPlaceholder("");
	}, [currentValue]);

	return (
		<TextField.Root
			size="1"
			value={fieldInput ?? ""}
			placeholder={fieldPlaceholder}
			disabled={fieldInput === undefined}
			onChange={(evt) => setFieldInput(evt.currentTarget.value)}
			onKeyDown={(evt) => {
				if (evt.key !== "Enter") return;
				onInputFinished(evt.currentTarget.value);
			}}
			onBlur={(evt) => {
				if (evt.currentTarget.value === currentValue) return;
				onInputFinished(evt.currentTarget.value);
			}}
			{...other}
		>
			{children}
		</TextField.Root>
	);
}

const LyricWordViewEditAdvance = ({
	wordAtom,
	wordIndex,
	line,
	lineIndex,
}: LyricWordViewEditProps) => {
	const store = useStore();
	const editLyricLines = useSetImmerAtom(lyricLinesAtom);
	const setOpenSplitWordDialog = useSetAtom(splitWordDialogAtom);
	const setSplitState = useSetAtom(editingWordStateAtom);
	const currentWord = useAtomValue(wordAtom);
	const toolMode = useAtomValue(toolModeAtom);
	const isWordSelectedAtom = useMemo(
		() => atom((get) => get(selectedWordsAtom).has(get(wordAtom).id)),
		[wordAtom],
	);
	const isWordSelected = useAtomValue(isWordSelectedAtom);

	const isWordBlank = useWordBlank(currentWord.word);
	const showRubyEditor = useMemo(
		() => currentWord.ruby !== undefined,
		[currentWord.ruby],
	);

	const hasBackflow = useMemo(
		() => isWordBackflowing(line, wordIndex),
		[line, wordIndex],
	);
	const hasError = useMemo(
		() => currentWord.startTime > currentWord.endTime || hasBackflow,
		[currentWord.startTime, currentWord.endTime, hasBackflow],
	);

	const hasRadical = useMemo(
		() => containsRadicalChar(currentWord.word),
		[currentWord.word],
	);

	const className = useMemo(
		() =>
			classNames(
				styles.lyricWord,
				styles.edit,
				styles.advance,
				isWordSelected && styles.selected,
				isWordBlank && styles.blank,
				showRubyEditor && styles.rubyEnabled,
				hasError && toolMode === ToolMode.Edit && styles.error,
				hasRadical && styles.radical,
			),
		[
			isWordBlank,
			isWordSelected,
			showRubyEditor,
			hasError,
			toolMode,
			hasRadical,
		],
	);

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger>
				<LyricWordViewEditSpan
					wordAtom={wordAtom}
					wordIndex={wordIndex}
					lineIndex={lineIndex}
					className={className}
					line={line}
				>
					<WordEditField
						size="1"
						color="green"
						wordAtom={wordAtom}
						fieldName="startTime"
						formatter={msToTimestamp}
						parser={parseTimespan}
						style={{
							minWidth: "0",
						}}
					>
						<TextField.Slot>
							<PaddingLeftRegular />
						</TextField.Slot>
					</WordEditField>
					<div className={styles.advanceBar}>
						<IconButton
							variant="soft"
							size="1"
							onClick={() => {
								setSplitState({
									wordIndex,
									lineIndex,
									word: currentWord.word,
								});
								setOpenSplitWordDialog(true);
							}}
						>
							<CutRegular />
						</IconButton>
						<WordEditField
							size="1"
							wordAtom={wordAtom}
							fieldName="word"
							formatter={String}
							parser={String}
							style={{
								minWidth: "0em",
							}}
						/>
						<IconButton
							variant="soft"
							size="1"
							onClick={() => {
								editLyricLines((state) => {
									const selectedWords = store.get(selectedWordsAtom);
									for (const line of state.lyricLines) {
										line.words = line.words.filter(
											(w) => !selectedWords.has(w.id),
										);
									}
								});
							}}
						>
							<DeleteRegular />
						</IconButton>
					</div>
					<div className={styles.rubyAdvanceRow}>
						<RubyEditor
							wordAtom={wordAtom}
							forceShow
							showIcon
							className={styles.rubyEditorCompact}
						/>
					</div>
					<WordEditField
						size="1"
						color="red"
						wordAtom={wordAtom}
						fieldName="endTime"
						formatter={msToTimestamp}
						parser={parseTimespan}
						style={{
							minWidth: "0",
						}}
					>
						<TextField.Slot>
							<PaddingRightRegular />
						</TextField.Slot>
					</WordEditField>
					<div className={styles.advanceBar}>
						<WordEditField
							size="1"
							type="number"
							min={0}
							wordAtom={wordAtom}
							fieldName="emptyBeat"
							formatter={String}
							parser={Number.parseInt}
							style={{
								minWidth: "0",
							}}
						>
							<TextField.Slot>
								<SplitVerticalRegular />
							</TextField.Slot>
						</WordEditField>
						<IconButton
							variant="soft"
							size="1"
							onClick={() => {
								editLyricLines((state) => {
									for (const line of state.lyricLines)
										for (const word of line.words)
											if (word.word === currentWord.word)
												word.emptyBeat = currentWord.emptyBeat;
								});
							}}
						>
							<TaskListLtrRegular />
						</IconButton>
					</div>
				</LyricWordViewEditSpan>
			</ContextMenu.Trigger>
			<ContextMenu.Content>
				<LyricWordMenu
					wordAtom={wordAtom}
					wordIndex={wordIndex}
					lineIndex={lineIndex}
				/>
				<LyricLineMenu lineIndex={lineIndex} />
			</ContextMenu.Content>
		</ContextMenu.Root>
	);
};

const LyricWorldViewEdit = ({
	wordAtom,
	wordIndex,
	line,
	lineIndex,
}: LyricWordViewEditProps) => {
	const { t } = useTranslation();
	const word = useAtomValue(wordAtom);
	const editLyricLines = useSetImmerAtom(lyricLinesAtom);
	const setSelectedLines = useSetImmerAtom(selectedLinesAtom);
	const isWordSelectedAtom = useMemo(
		() => atom((get) => get(selectedWordsAtom).has(get(wordAtom).id)),
		[wordAtom],
	);
	const isWordSelected = useAtomValue(isWordSelectedAtom);
	const setSelectedWords = useSetImmerAtom(selectedWordsAtom);
	const [editing, setEditing] = useState(false);
	const toolMode = useAtomValue(toolModeAtom);
	const isWordBlank = useWordBlank(word.word);
	const displayWord = getDisplayWordText(t, word.word, isWordBlank);
	const showRubyEditor = useMemo(() => word.ruby !== undefined, [word.ruby]);

	const hasBackflow = useMemo(
		() => isWordBackflowing(line, wordIndex),
		[line, wordIndex],
	);
	const hasError = useMemo(
		() => word.startTime > word.endTime || hasBackflow,
		[word.startTime, word.endTime, hasBackflow],
	);

	const hasRadical = useMemo(() => containsRadicalChar(word.word), [word.word]);

	const className = useMemo(
		() =>
			classNames(
				styles.lyricWord,
				styles.edit,
				isWordSelected && styles.selected,
				isWordBlank && styles.blank,
				showRubyEditor && styles.rubyEnabled,
				hasError && toolMode === ToolMode.Edit && styles.error,
				hasRadical && styles.radical,
			),
		[
			isWordBlank,
			isWordSelected,
			showRubyEditor,
			hasError,
			toolMode,
			hasRadical,
		],
	);

	const onEnter = useCallback(
		(evt: SyntheticEvent<HTMLInputElement>) => {
			setEditing(false);
			const { word: parsedWord, enableRuby } = parseRubyShortcut(
				evt.currentTarget.value,
			);
			if (parsedWord !== word.word || enableRuby) {
				editLyricLines((state) => {
					const targetWord = state.lyricLines[lineIndex]?.words[wordIndex];
					if (!targetWord) return;
					targetWord.word = parsedWord;
					if (enableRuby && !targetWord.ruby) {
						targetWord.ruby = [];
					}
				});
			}
		},
		[editLyricLines, lineIndex, word.word, wordIndex],
	);

	return editing ? (
		<div className={className}>
			<span className={styles.wordEditRow}>
				<TextField.Root
					autoFocus
					defaultValue={word.word}
					onBlur={onEnter}
					onKeyDown={(evt) => {
						if (evt.key === "Enter") onEnter(evt);
					}}
				/>
				{showRubyEditor && <RubyEditor wordAtom={wordAtom} />}
			</span>
		</div>
	) : (
		<ContextMenu.Root
			onOpenChange={(open) => {
				if (!open) return;
				if (isWordSelected) return;
				setSelectedWords((state) => {
					state.clear();
					state.add(word.id);
				});
				setSelectedLines((state) => {
					state.clear();
					state.add(line.id);
				});
			}}
		>
			<ContextMenu.Trigger>
				<LyricWordViewEditSpan
					wordAtom={wordAtom}
					wordIndex={wordIndex}
					lineIndex={lineIndex}
					className={className}
					line={line}
					onDoubleClick={() => {
						setEditing(true);
					}}
				>
					<span className={styles.wordEditRow}>
						{displayWord}
						{showRubyEditor && <RubyEditor wordAtom={wordAtom} />}
					</span>
				</LyricWordViewEditSpan>
			</ContextMenu.Trigger>
			<ContextMenu.Content>
				<LyricWordMenu
					wordAtom={wordAtom}
					wordIndex={wordIndex}
					lineIndex={lineIndex}
				/>
				<LyricLineMenu lineIndex={lineIndex} />
			</ContextMenu.Content>
		</ContextMenu.Root>
	);
};

const LyricSyncWordView: FC<{
	syncId: string;
	line: LyricLine;
	startTime: number;
	endTime: number;
	syllable: string;
	kana?: string;
	roman?: string;
	isWordBlank: boolean;
	word?: string;
	hasBackflow: boolean;
}> = ({
	syncId,
	line,
	startTime,
	endTime,
	syllable,
	kana,
	roman,
	isWordBlank,
	word,
	hasBackflow,
}) => {
	const isWordSelectedAtom = useMemo(
		() => atom((get) => get(selectedWordsAtom).has(syncId)),
		[syncId],
	);
	const isWordSelected = useAtomValue(isWordSelectedAtom);
	const setSelectedWords = useSetImmerAtom(selectedWordsAtom);
	const setSelectedLines = useSetImmerAtom(selectedLinesAtom);
	const visualizeTimestampUpdate = useAtomValue(visualizeTimestampUpdateAtom);
	const showTimestamps = useAtomValue(showTimestampsAtom);
	const showEndTimeAsDuration = useAtomValue(showEndTimeAsDurationAtom);
	const highlightErrors = useAtomValue(highlightErrorsAtom);
	const highlightActiveWord = useAtomValue(highlightActiveWordAtom);
	const toolMode = useAtomValue(toolModeAtom);
	const wordDisplayMode = useAtomValue(syncWordDisplayModeAtom);

	// 只显示音译模式下：无音译数据时回退显示原文音节（与旧行为一致）
	const romanText =
		wordDisplayMode === SyncWordDisplayMode.Roman && (!roman || roman.trim() === "")
			? syllable
			: roman;

	const startTimeRef = useRef<HTMLDivElement>(null);
	const endTimeRef = useRef<HTMLDivElement>(null);

	const wordContainerRef = useRef<HTMLDivElement>(null);
	const isActiveRef = useRef(false);

	useEffect(() => {
		const updateActiveState = (timeInSeconds: number) => {
			if (!wordContainerRef.current) return;
			if (!highlightActiveWord) {
				if (isActiveRef.current) {
					isActiveRef.current = false;
					wordContainerRef.current.classList.remove(styles.active);
				}
				return;
			}
			const currentMs = timeInSeconds * 1000;
			const isActive = currentMs >= startTime && currentMs < endTime;
			if (isActive !== isActiveRef.current) {
				isActiveRef.current = isActive;
				if (isActive) {
					wordContainerRef.current.classList.add(styles.active);
				} else {
					wordContainerRef.current.classList.remove(styles.active);
				}
			}
		};

		updateActiveState(audioEngine.musicCurrentTime);
		audioEngine.onTimeUpdate(updateActiveState);
		return () => audioEngine.offTimeUpdate(updateActiveState);
	}, [startTime, endTime, highlightActiveWord]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 用于呈现时间戳更新效果
	useEffect(() => {
		if (!visualizeTimestampUpdate) return;
		const animation = startTimeRef.current?.animate(
			[
				{
					backgroundColor: "var(--green-a8)",
				},
				{
					backgroundColor: "var(--green-a4)",
				},
			],
			{
				duration: 500,
			},
		);

		return () => {
			animation?.cancel();
		};
	}, [startTime, visualizeTimestampUpdate]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 用于呈现时间戳更新效果
	useEffect(() => {
		if (!visualizeTimestampUpdate) return;
		const animation = endTimeRef.current?.animate(
			[
				{
					backgroundColor: "var(--red-a8)",
				},
				{
					backgroundColor: "var(--red-a4)",
				},
			],
			{
				duration: 500,
			},
		);

		return () => {
			animation?.cancel();
		};
	}, [endTime, visualizeTimestampUpdate]);

	const hasError = useMemo(
		() => startTime > endTime || hasBackflow,
		[startTime, endTime, hasBackflow],
	);

	const hasRadical = useMemo(
		() => (word ? containsRadicalChar(word) : false),
		[word],
	);

	const className = useMemo(
		() =>
			classNames(
				styles.lyricWord,
				styles.sync,
				isWordSelected && styles.selected,
				isWordBlank && styles.blank,
				hasError &&
					(toolMode === ToolMode.Edit ||
						(toolMode === ToolMode.Sync &&
							showTimestamps &&
							highlightErrors)) &&
					styles.error,
				hasRadical && styles.radical,
			),
		[
			isWordBlank,
			isWordSelected,
			hasError,
			toolMode,
			showTimestamps,
			highlightErrors,
			hasRadical,
		],
	);

	return (
		<div
			ref={wordContainerRef}
			className={className}
			data-wdmode={wordDisplayMode}
			onClick={(evt) => {
				evt.stopPropagation();
				evt.preventDefault();
				setSelectedLines((state) => {
					state.clear();
					state.add(line.id);
				});
				setSelectedWords((state) => {
					state.clear();
					state.add(syncId);
				});
			}}
		>
			{showTimestamps && (
				<div className={classNames(styles.startTime)} ref={startTimeRef}>
					{msToTimestamp(startTime)}
				</div>
			)}
			<div
				className={styles.wordKana}
				data-empty={!kana || kana.trim() === "" || undefined}
			>
				{kana}
			</div>
			<div className={styles.displayWord}>{syllable}</div>
			<div
				className={styles.wordRoman}
				data-empty={!romanText || romanText.trim() === "" || undefined}
			>
				{romanText}
			</div>
			{showTimestamps && (
				<div className={classNames(styles.endTime)} ref={endTimeRef}>
					{showEndTimeAsDuration
						? `+${endTime - startTime}ms`
						: msToTimestamp(endTime)}
				</div>
			)}
		</div>
	);
};

const LyricWorldViewSync: FC<{
	wordAtom: Atom<LyricWord>;
	wordIndex: number;
	line: LyricLine;
	lineIndex: number;
}> = ({ wordAtom, line }) => {
	const { t } = useTranslation();
	const word = useAtomValue(wordAtom);
	const lineBackflows = useMemo(
		() => detectLineBackflows(line),
		[line],
	);
	const isWordBlank = useWordBlank(word.word);
	const getDisplayWord = useCallback(
		(displayText: string, isBlank: boolean) =>
		getDisplayWordText(t, displayText, isBlank),
		[t],
	);

	if (word.ruby && word.ruby.length > 0) {
		// 一个字只渲染一张卡片：中间显示原字，上方拼合显示全部假名，
		// 时间取假名并集（与 AMLL 渲染一致）；无假名的单词由 CSS 保留上方占位，
		// 保证所有卡片高度一致、底部时间标签对齐
		const kanaText = word.ruby.map((rubyWord) => rubyWord.word).join("");
		const hasKana = kanaText.trim().length > 0;
		const hasRubyBackflow = word.ruby.some((_, rubyIndex) =>
			lineBackflows[buildRubySelectionId(word.id, rubyIndex)],
		);
		return (
			<LyricSyncWordView
				syncId={word.id}
				hasBackflow={hasRubyBackflow || Boolean(lineBackflows[word.id])}
				line={line}
				startTime={getWordSyncStartTime(word)}
				endTime={getWordSyncEndTime(word)}
				syllable={
					word.word.trim().length > 0
						? word.word
						: getDisplayWord(kanaText, !hasKana)
				}
				kana={hasKana ? kanaText : undefined}
				roman={word.romanWord}
				isWordBlank={isWordBlank}
				word={word.word.trim().length > 0 ? word.word : kanaText}
			/>
		);
	}

	return (
		<LyricSyncWordView
			syncId={word.id}
			hasBackflow={Boolean(lineBackflows[word.id])}
			line={line}
			startTime={word.startTime}
			endTime={word.endTime}
			syllable={getDisplayWord(word.word, isWordBlank)}
			roman={word.romanWord}
			isWordBlank={isWordBlank}
			word={word.word}
		/>
	);
};

export const LyricWordView: FC<{
	wordAtom: Atom<LyricWord>;
	wordIndex: number;
	line: LyricLine;
	lineIndex: number;
}> = memo(({ wordAtom, wordIndex, line, lineIndex }) => {
	const word = useAtomValue(wordAtom);
	const toolMode = useAtomValue(toolModeAtom);
	const layoutMode = useAtomValue(layoutModeAtom);

	const isWordBlank = useWordBlank(word.word);
	const hasRuby = word.ruby && word.ruby.length > 0;

	return (
		<div>
			{toolMode === ToolMode.Edit && layoutMode === LayoutMode.Simple && (
				<LyricWorldViewEdit
					wordAtom={wordAtom}
					line={line}
					lineIndex={lineIndex}
					wordIndex={wordIndex}
				/>
			)}
			{toolMode === ToolMode.Edit && layoutMode === LayoutMode.Advance && (
				<LyricWordViewEditAdvance
					wordAtom={wordAtom}
					line={line}
					lineIndex={lineIndex}
					wordIndex={wordIndex}
				/>
			)}
			{toolMode === ToolMode.Sync && (hasRuby || !isWordBlank) && (
				<LyricWorldViewSync
					wordAtom={wordAtom}
					line={line}
					lineIndex={lineIndex}
					wordIndex={wordIndex}
				/>
			)}
		</div>
	);
});

export default LyricWordView;
