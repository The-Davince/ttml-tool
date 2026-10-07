import {
	CheckmarkCircle16Regular,
	ErrorCircle16Regular,
	Warning16Regular,
} from "@fluentui/react-icons";
import { Box, SegmentedControl, Text } from "@radix-ui/themes";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	backflowUnitsAtom,
	type BackflowUnitInfo,
	getDisplayLineNumber,
	locateUnit,
} from "$/modules/lyric-editor/utils/backflow";
import {
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
	ToolMode,
	toolModeAtom,
} from "$/states/main";
import {
	lyricMessagesAtom,
	messagesSortModeAtom,
	type MessagesSortMode,
} from "$/states/messages";
import { outlineJumpActionAtom } from "$/states/sidebar";
import styles from "./MessagesPanel.module.css";

interface PanelMessage {
	unitId: string;
	info?: BackflowUnitInfo;
	firstDetectedAt: number;
	active: boolean;
	lineIndex: number;
	wordIndex: number;
	rubyIndex?: number;
}

export const MessagesPanel = memo(() => {
	const { t } = useTranslation();
	const lyricLines = useAtomValue(lyricLinesAtom).lyricLines;
	const backflowUnits = useAtomValue(backflowUnitsAtom);
	const messages = useAtomValue(lyricMessagesAtom);
	const [sortMode, setSortMode] = useAtom(messagesSortModeAtom);
	const setToolMode = useSetAtom(toolModeAtom);
	const setSelectedLines = useSetAtom(selectedLinesAtom);
	const setSelectedWords = useSetAtom(selectedWordsAtom);
	const setJumpAction = useSetAtom(outlineJumpActionAtom);

	// 将消息记录与实时倒流状态、行位置信息联接
	const panelMessages = useMemo(() => {
		const result: PanelMessage[] = [];
		for (const [unitId, record] of Object.entries(messages)) {
			const location = locateUnit(lyricLines, unitId);
			if (!location) continue; // 音节已不存在（正常情况下会被消息中心清理）
			const info = backflowUnits[unitId];
			result.push({
				unitId,
				info,
				firstDetectedAt: record.firstDetectedAt,
				active: Boolean(info),
				lineIndex: location.lineIndex,
				wordIndex: location.wordIndex,
				rubyIndex: location.rubyIndex,
			});
		}
		if (sortMode === "position") {
			// 按行号和音节位置从小到大排序
			result.sort((a, b) => {
				if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
				if (a.wordIndex !== b.wordIndex) return a.wordIndex - b.wordIndex;
				return (a.rubyIndex ?? -1) - (b.rubyIndex ?? -1);
			});
		} else {
			// 按检测到倒流时的时间先后排序
			result.sort((a, b) => a.firstDetectedAt - b.firstDetectedAt);
		}
		return result;
	}, [lyricLines, backflowUnits, messages, sortMode]);

	const activeCount = useMemo(
		() => panelMessages.filter((m) => m.active).length,
		[panelMessages],
	);

	const handleMessageClick = useCallback(
		(message: PanelMessage) => {
			if (!message.active) return; // 已修复的消息无对应操作
			const line = lyricLines[message.lineIndex];
			if (!line) return;
			// 预览模式下编辑器未挂载，先切回编辑模式
			setToolMode((prev) => (prev === ToolMode.Preview ? ToolMode.Edit : prev));
			setSelectedLines(new Set([line.id]));
			// 假名消息同时选中其所属单词，保证编辑模式下单词卡片也有选中反馈
			const wordIds = new Set([message.unitId]);
			const word = line.words[message.wordIndex];
			if (word && message.rubyIndex !== undefined) wordIds.add(word.id);
			setSelectedWords(wordIds);
			setJumpAction({ id: line.id, ts: Date.now() });
		},
		[lyricLines, setToolMode, setSelectedLines, setSelectedWords, setJumpAction],
	);

	const renderMessageText = useCallback(
		(message: PanelMessage) => {
			const line = lyricLines[message.lineIndex];
			const word = line?.words[message.wordIndex];
			if (!line || !word) return null;
			const lineNumber = getDisplayLineNumber(lyricLines, message.lineIndex);
			// 音节编号按行内非空白单词计数
			let syllableNumber = 0;
			for (let i = 0; i <= message.wordIndex; i++) {
				if (line.words[i].word.trim().length > 0) syllableNumber++;
			}
			if (message.rubyIndex !== undefined) {
				const rubyWord = word.ruby?.[message.rubyIndex];
				return t(
					"sidebar.messages.backflowRuby",
					"第 {line} 行第 {word} 个音节 ''{text}'' 的第 {ruby} 个假名 ''{rubyText}'' 出现倒流",
					{
						line: lineNumber,
						word: syllableNumber,
						text: word.word,
						ruby: message.rubyIndex + 1,
						rubyText: rubyWord?.word ?? "",
					},
				);
			}
			return t(
				"sidebar.messages.backflowWord",
				"第 {line} 行第 {word} 个音节 ''{text}'' 出现倒流",
				{
					line: lineNumber,
					word: syllableNumber,
					text: word.word,
				},
			);
		},
		[lyricLines, t],
	);

	const renderDetailText = useCallback(
		(message: PanelMessage) => {
			if (!message.active || !message.info) return null;
			// 音节自身倒挂：结束时间早于开始时间
			if (message.info.type === "self") {
				return t(
					"sidebar.messages.backflowSelfDetail",
					"结束时间 ({endTime}) 早于开始时间 ({startTime})",
					{
						endTime: message.info.endTime,
						startTime: message.info.startTime,
					},
				);
			}
			return t(
				"sidebar.messages.backflowDetail",
				"开始时间 ({startTime}) 早于前一个音节的结束时间 ({prevEndTime})",
				{
					startTime: message.info.startTime,
					prevEndTime: message.info.prevEndTime,
				},
			);
		},
		[t],
	);

	return (
		<div className={styles.container}>
			<div className={styles.toolbar}>
				<Text size="1" color="gray" className={styles.countText}>
					{t("sidebar.messages.count", {
						defaultValue: "共 {total} 条消息",
						total: panelMessages.length,
					})}
					{activeCount > 0 &&
						t("sidebar.messages.activeCount", {
							defaultValue: "，{pending} 条待处理",
							pending: activeCount,
						})}
				</Text>
				<SegmentedControl.Root
					size="1"
					value={sortMode}
					onValueChange={(v) => setSortMode(v as MessagesSortMode)}
				>
					<SegmentedControl.Item value="time">
						{t("sidebar.messages.sortByTime", "按时间")}
					</SegmentedControl.Item>
					<SegmentedControl.Item value="position">
						{t("sidebar.messages.sortByPosition", "按位置")}
					</SegmentedControl.Item>
				</SegmentedControl.Root>
			</div>

			{panelMessages.length === 0 ? (
				<Box className={styles.emptyState}>
					<ErrorCircle16Regular className={styles.emptyIcon} />
					<Text size="2" color="gray">
						{t("sidebar.messages.empty", "暂无消息")}
					</Text>
				</Box>
			) : (
				<div className={styles.messageList}>
					{panelMessages.map((message) => (
						<div
							key={message.unitId}
							className={styles.messageItem}
							data-active={message.active}
							onClick={() => handleMessageClick(message)}
							onKeyDown={(e) => {
								if (!message.active) return;
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									handleMessageClick(message);
								}
							}}
							role={message.active ? "button" : undefined}
							tabIndex={message.active ? 0 : -1}
						>
							<div className={styles.statusIcon}>
								{message.active ? (
									<Warning16Regular className={styles.activeIcon} />
								) : (
									<CheckmarkCircle16Regular className={styles.resolvedIcon} />
								)}
							</div>
							<div className={styles.messageContent}>
								<div className={styles.messageText}>
									{renderMessageText(message)}
								</div>
								{renderDetailText(message) && (
									<div className={styles.detailText}>
										{renderDetailText(message)}
									</div>
								)}
								<div className={styles.metaText}>
									{message.active
										? t("sidebar.messages.detectedAt", "检测于 {time}", {
												time: new Date(message.firstDetectedAt).toLocaleTimeString(),
											})
										: t("sidebar.messages.resolvedLabel", "已修复")}
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
});

export default MessagesPanel;
