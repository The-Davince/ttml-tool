import { Warning16Regular } from "@fluentui/react-icons";
import { Box, Card, Flex, Text } from "@radix-ui/themes";
import { useAtomValue, useSetAtom } from "jotai";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	backflowUnitsAtom,
	getDisplayLineNumber,
	type BackflowUnitInfo,
	locateUnit,
} from "$/modules/lyric-editor/utils/backflow";
import {
	lyricLinesAtom,
	selectedLinesAtom,
	selectedWordsAtom,
	ToolMode,
	toolModeAtom,
} from "$/states/main";
import { outlineJumpActionAtom } from "$/states/sidebar";
import styles from "./index.module.css";

/**
 * 跳转到某个倒流音节
 */
export function useJumpToUnit() {
	const lyricLines = useAtomValue(lyricLinesAtom).lyricLines;
	const setToolMode = useSetAtom(toolModeAtom);
	const setSelectedLines = useSetAtom(selectedLinesAtom);
	const setSelectedWords = useSetAtom(selectedWordsAtom);
	const setJumpAction = useSetAtom(outlineJumpActionAtom);

	return useCallback(
		(unitId: string) => {
			const loc = locateUnit(lyricLines, unitId);
			if (!loc) return;
			const line = lyricLines[loc.lineIndex];
			if (!line) return;
			setToolMode((prev) => (prev === ToolMode.Preview ? ToolMode.Edit : prev));
			setSelectedLines(new Set([line.id]));
			const wordIds = new Set([unitId]);
			const word = line.words[loc.wordIndex];
			if (word && loc.rubyIndex !== undefined) wordIds.add(word.id);
			setSelectedWords(wordIds);
			setJumpAction({ id: line.id, ts: Date.now() });
		},
		[
			lyricLines,
			setToolMode,
			setSelectedLines,
			setSelectedWords,
			setJumpAction,
		],
	);
}

interface GuardRow {
	info: BackflowUnitInfo;
	lineIndex: number;
	wordIndex: number;
	rubyIndex?: number;
}

/**
 * 存在倒流时替换预览渲染 修复后恢复
 */
export const BackflowGuard = memo(() => {
	const { t } = useTranslation();
	const lyricLines = useAtomValue(lyricLinesAtom).lyricLines;
	const backflowUnits = useAtomValue(backflowUnitsAtom);
	const jump = useJumpToUnit();

	const rows = useMemo<GuardRow[]>(() => {
		const list: GuardRow[] = [];
		for (const info of Object.values(backflowUnits)) {
			const loc = locateUnit(lyricLines, info.unitId);
			if (!loc) continue;
			list.push({ info, ...loc });
		}
		list.sort((a, b) => {
			if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex;
			if (a.wordIndex !== b.wordIndex) return a.wordIndex - b.wordIndex;
			return (a.rubyIndex ?? -1) - (b.rubyIndex ?? -1);
		});
		return list;
	}, [lyricLines, backflowUnits]);

	const renderText = useCallback(
		(row: GuardRow) => {
			const line = lyricLines[row.lineIndex];
			const word = line?.words[row.wordIndex];
			if (!line || !word) return null;
			const lineNumber = getDisplayLineNumber(lyricLines, row.lineIndex);
			let syllableNumber = 0;
			for (let i = 0; i <= row.wordIndex; i++) {
				if (line.words[i].word.trim().length > 0) syllableNumber++;
			}
			if (row.rubyIndex !== undefined) {
				const rubyWord = word.ruby?.[row.rubyIndex];
				return t(
					"sidebar.messages.backflowRuby",
					"第 {line} 行第 {word} 个音节 ''{text}'' 的第 {ruby} 个假名 ''{rubyText}'' 出现倒流",
					{
						line: lineNumber,
						word: syllableNumber,
						text: word.word,
						ruby: row.rubyIndex + 1,
						rubyText: rubyWord?.word ?? "",
					},
				);
			}
			return t(
				"sidebar.messages.backflowWord",
				"第 {line} 行第 {word} 个音节 ''{text}'' 出现倒流",
				{ line: lineNumber, word: syllableNumber, text: word.word },
			);
		},
		[lyricLines, t],
	);

	const renderDetail = useCallback(
		(info: BackflowUnitInfo) => {
			if (info.type === "self") {
				return t(
					"sidebar.messages.backflowSelfDetail",
					"结束时间 ({endTime}) 早于开始时间 ({startTime})",
					{ endTime: info.endTime, startTime: info.startTime },
				);
			}
			return t(
				"sidebar.messages.backflowDetail",
				"开始时间 ({startTime}) 早于前一个音节的结束时间 ({prevEndTime})",
				{ startTime: info.startTime, prevEndTime: info.prevEndTime },
			);
		},
		[t],
	);

	return (
		<Card className={styles.guard}>
			<Flex direction="column" gap="3" className={styles.inner}>
				<Flex gap="2" align="center" className={styles.header}>
					<Warning16Regular className={styles.warnIcon} />
					<Text size="3" weight="medium" className={styles.title}>
						{t("sidebar.messages.guardTitle", "检测到音节倒流")}
					</Text>
					<Text size="1" color="gray">
						{t("sidebar.messages.guardCount", {
							defaultValue: "共 {n} 处",
							n: rows.length,
						})}
					</Text>
				</Flex>
				<Text size="2" color="gray" className={styles.hint}>
					{t(
						"sidebar.messages.guardHint",
						"修复以下音节的时间倒流后即可正常预览；点击任意一条可跳转到对应音节。",
					)}
				</Text>
				<Box className={styles.list}>
					{rows.map((row) => (
						<div
							key={row.info.unitId}
							className={styles.row}
							role="button"
							tabIndex={0}
							onClick={() => jump(row.info.unitId)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									jump(row.info.unitId);
								}
							}}
						>
							<div className={styles.rowText}>{renderText(row)}</div>
							<div className={styles.rowDetail}>{renderDetail(row.info)}</div>
						</div>
					))}
				</Box>
			</Flex>
		</Card>
	);
});

export default BackflowGuard;
