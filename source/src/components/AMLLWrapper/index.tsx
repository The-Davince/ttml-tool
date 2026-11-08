import "@applemusic-like-lyrics/core/style.css";
// import { MaskObsceneWordsMode } from "@applemusic-like-lyrics/core";
import {
        LyricPlayer,
        type LyricPlayerRef,
} from "@applemusic-like-lyrics/react";
import { Card } from "@radix-ui/themes";
import structuredClone from "@ungap/structured-clone";
import classNames from "classnames";
import { useAtomValue, useSetAtom } from "jotai";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { audioEngine } from "$/modules/audio/audio-engine";
import { audioPlayingAtom } from "$/modules/audio/states";
import {
        // hideObsceneWordsAtom,
        lyricWordFadeWidthAtom,
        showRomanLinesAtom,
        showTranslationLinesAtom,
        swapRomanTranslationAtom,
} from "$/modules/settings/states/preview";
import { BackflowGuard, useJumpToUnit } from "$/components/BackflowGuard";
import {
	backflowUnitsAtom,
	locateUnit,
} from "$/modules/lyric-editor/utils/backflow";
import { useTranslation } from "react-i18next";
import { confirmDialogAtom } from "$/states/dialogs";
import { isDarkThemeAtom, lyricLinesAtom } from "$/states/main.ts";
import type { LyricLine } from "$/types/ttml";
import type { OptimizeLyricOptions } from "@applemusic-like-lyrics/core";
import styles from "./index.module.css";

// amll-core optimizeLyricLines 无条件跑 convertExcessiveBackgroundLines, 无开关可关,
// 只能靠预览层预处理自控: buildPreviewLines 只把主行和首个被绑 B 塞给 playerLines,
// 其余 C/D 从裸数组摘出挂在主行 queueRows 上走自渲染浮层, 绕开库的 backgroundVocal 单槽路径.
// 能关的 syncMainAndBackgroundLines 照关: 它会把主行与紧跟单 BG 取 min start/max end 改写边界,
// 库里只留 B 也怕它改写. 其余默认保持开启.
const previewOptimizeOptions: OptimizeLyricOptions = { syncMainAndBackgroundLines: false };

type BgGroup = { main: LyricLine; rows: LyricLine[] };

function mainOf(all: LyricLine[], line: LyricLine) {
	if (line.followMainLineId) {
		for (const item of all) {
			if (item.id === line.followMainLineId) return item;
		}
	}
	const index = all.indexOf(line);
	for (let i = index - 1; i >= 0; i--) {
		if (!all[i].isBG) return all[i];
	}
	return null;
}

function buildBgGroups(all: LyricLine[], bound: LyricLine[]) {
	const groups = new Map<string, BgGroup>();
	for (const row of bound) {
		const main = mainOf(all, row);
		if (!main) continue;
		const item = groups.get(main.id) ?? { main, rows: [] };
		item.rows.push(row);
		groups.set(main.id, item);
	}
	const ordered = [...groups.values()];
	ordered.sort((a, b) => {
		const aStart = Math.min(...a.rows.map((line) => line.startTime));
		const bStart = Math.min(...b.rows.map((line) => line.startTime));
		return aStart - bStart;
	});
	for (const group of ordered) {
		group.rows.sort((a, b) => a.startTime - b.startTime);
	}
	return ordered;
}

function buildPreviewLines(lines: LyricLine[]) {
	const mains: LyricLine[] = [];
	const bound: LyricLine[] = [];
	const solo: LyricLine[] = [];
	for (const line of lines) {
		if (!line.isBG) mains.push(line);
		else if (line.followMainTimeline) bound.push(line);
		else solo.push(line);
	}
	const groups = buildBgGroups(lines, bound);
	for (const main of mains) main.queueRows = [];
	for (const group of groups) {
		for (let i = 1; i < group.rows.length; i++) {
			group.main.queueRows.push(group.rows[i]);
		}
	}
	const playerLines: LyricLine[] = [];
	for (const main of mains) {
		playerLines.push(main);
		const group = groups.find((item) => item.main.id === main.id);
		if (group && group.rows.length > 0) playerLines.push(group.rows[0]);
	}
	const soloSorted = [...solo].sort((a, b) => a.startTime - b.startTime);
	return { all: lines, mains, bound, solo: soloSorted, playerLines, groups };
}

function queueVisible(main: LyricLine, line: LyricLine, atMs: number) {
	const mainOn = atMs >= main.startTime && atMs <= main.endTime;
	if (!mainOn) return false;
	const rows = main.queueRows;
	const last = rows[rows.length - 1];
	const mode = line.followQueueMode ?? "stack";
	const active = atMs >= line.startTime && atMs <= line.endTime;
	if (mode === "replace") {
		if (active) {
			for (const row of rows) {
				if (row.id === line.id) break;
				if (atMs >= row.startTime && atMs <= row.endTime) return false;
			}
			return true;
		}
		return Boolean(last && last.id === line.id);
	}
	if (active) return true;
	if (!last || last.id !== line.id) return false;
	for (let i = 0; i < rows.length - 1; i++) {
		const prev = rows[i];
		if (atMs <= prev.endTime) return false;
	}
	return true;
}

function isMainLine(rowId: string | undefined, mains: LyricLine[]) {
	if (!rowId) return false;
	return mains.some((main) => main.id === rowId);
}

export const AMLLWrapper = memo(() => {
        const originalLyricLines = useAtomValue(lyricLinesAtom);
        const isPlaying = useAtomValue(audioPlayingAtom);
        const darkMode = useAtomValue(isDarkThemeAtom);
        const showTranslationLines = useAtomValue(showTranslationLinesAtom);
        const showRomanLines = useAtomValue(showRomanLinesAtom);
        const swapRomanTranslation = useAtomValue(swapRomanTranslationAtom);
        // const hideObsceneWords = useAtomValue(hideObsceneWordsAtom);
        const wordFadeWidth = useAtomValue(lyricWordFadeWidthAtom);
        const playerRef = useRef<LyricPlayerRef>(null);
        const lastMsRef = useRef(-1);
        const [nowMs, setNowMs] = useState(() => audioEngine.musicCurrentTime * 1000);

        const lyricLines = useMemo(() => {
                return buildPreviewLines(structuredClone(
                        originalLyricLines.lyricLines.map((line) => ({
                                ...line,
                                translatedLyric: showTranslationLines ? line.translatedLyric : "",
                                romanLyric: showRomanLines ? line.romanLyric : "",
                        })),
                ));
        }, [originalLyricLines, showTranslationLines, showRomanLines]);

        const soloRows = useMemo(() => {
                const one: LyricLine[] = [];
                for (const line of lyricLines.solo) {
                        if (one.some((kept) => line.startTime < kept.endTime && line.endTime > kept.startTime)) continue;
                        one.push(line);
                }
                return one;
        }, [lyricLines]);

        const seekById = useMemo(() => {
                const map = new Map<string, number>();
                for (const line of lyricLines.all) map.set(line.id, line.startTime);
                return map;
        }, [lyricLines]);
        
        // 倒流拦截：存在音节时间倒流时不渲染 AMLL（其校验会对 startTime>endTime 抛 RangeError），
        // 改为展示可跳转的守卫面板，全部修复后自动恢复预览。
        const { t } = useTranslation();
        const backflowUnits = useAtomValue(backflowUnitsAtom);
        const setDialog = useSetAtom(confirmDialogAtom);
        const jumpToUnit = useJumpToUnit();
        const hasBackflow = Object.keys(backflowUnits).length > 0;
        
        const firstBackflowUnitId = useMemo(() => {
        	const rows = Object.values(backflowUnits)
        		.map((info) => ({
        			info,
        			loc: locateUnit(originalLyricLines.lyricLines, info.unitId),
        		}))
        		.filter((r) => r.loc)
        		.sort((a, b) =>
        			a.loc!.lineIndex !== b.loc!.lineIndex
        				? a.loc!.lineIndex - b.loc!.lineIndex
        				: a.loc!.wordIndex !== b.loc!.wordIndex
        					? a.loc!.wordIndex - b.loc!.wordIndex
        					: (a.loc!.rubyIndex ?? -1) - (b.loc!.rubyIndex ?? -1),
        		);
        	return rows[0]?.info.unitId;
        }, [backflowUnits, originalLyricLines]);
        
        // 仅在“带着倒流进入预览”的那一刻提示一次（不随后续编辑重复弹窗）。
        useEffect(() => {
        	if (!hasBackflow) return;
        	setDialog({
        		open: true,
        		title: t("sidebar.messages.guardTitle", "检测到音节倒流"),
        		description: t(
        			"sidebar.messages.guardDesc",
        			"当前歌词存在 {n} 处音节时间倒流，修复后才能正常预览，是否前往修复第一处？",
        			{ n: Object.keys(backflowUnits).length },
        		),
        		onConfirm: () => {
        			if (firstBackflowUnitId) jumpToUnit(firstBackflowUnitId);
        		},
        	});
        	// biome-ignore lint/correctness/useExhaustiveDependencies: 仅在进入预览时提示一次
        }, []);

        useEffect(() => {
                const updateAMLLTime = (timeInSeconds: number) => {
                        const ms = timeInSeconds * 1000;
                        const beat = Math.floor(ms / 150);
                        const lastBeat = Math.floor(lastMsRef.current / 150);
                        if (beat !== lastBeat) {
                                lastMsRef.current = ms;
                                setNowMs(ms);
                        }
                        if (playerRef.current?.lyricPlayer) {
                                playerRef.current.lyricPlayer.setCurrentTime(ms);
                        }
                };

                updateAMLLTime(audioEngine.musicCurrentTime);
                audioEngine.onTimeUpdate(updateAMLLTime);
                return () => audioEngine.offTimeUpdate(updateAMLLTime);
        }, []);

        // 存在倒流时用守卫面板替换 AMLL 预览，避免其时间校验抛 RangeError。
        if (hasBackflow) {
                return <BackflowGuard />;
        }

        return (
                <Card
                        className={classNames(
                                styles.amllWrapper,
                                darkMode && styles.isDark,
                                swapRomanTranslation && styles.swapSubLines,
                                styles.bgStack,
                        )}
                >
                        <LyricPlayer
                                style={{
                                        height: "100%",
                                        boxSizing: "content-box",
                                }}
                                onLyricLineClick={(evt) => {
                                        const lineId = (evt.line.getLine() as { id?: string }).id;
                                        if (!isMainLine(lineId, lyricLines.mains)) return;
                                        playerRef.current?.lyricPlayer?.resetScroll();
                                        const ms = (lineId ? seekById.get(lineId) : undefined) ?? evt.line.getLine().startTime;
                                        audioEngine.seekMusic(ms / 1000);
                                }}
                                lyricLines={lyricLines.playerLines}
                                optimizeOptions={previewOptimizeOptions}
                                playing={isPlaying}
                                // maskObsceneWordsMode={
                                //      hideObsceneWords
                                //              ? MaskObsceneWordsMode.FullMask
                                //              : MaskObsceneWordsMode.Disabled
                                // }
                                wordFadeWidth={wordFadeWidth}
                                ref={playerRef}
                        />
                        <div className={styles.bgLayer} aria-hidden="true">
                                {lyricLines.groups.map((group) => {
                                        const mainOn = nowMs >= group.main.startTime && nowMs <= group.main.endTime;
                                        const rows = group.main.queueRows;
                                        const visible = rows.map((line) => queueVisible(group.main, line, nowMs));
                                        return (
                                                <div key={group.main.id} className={styles.bgGroup} style={{ height: visible.length > 0 ? "1px" : "0px" }}>
                                                        {rows.map((line, index) => {
                                                                const on = visible[index] && mainOn;
                                                                let slot = 0;
                                                                if (on) {
                                                                        slot = visible.filter((v, i) => i < index && v).length;
                                                                }
                                                                return (
                                                                        <div
                                                                                key={line.id}
                                                                                className={classNames(
                                                                                        styles.bgRow,
                                                                                        on ? styles.bgRowOn : styles.bgRowOff,
                                                                                )}
                                                                                style={{ bottom: `${slot * 20}px` }}
                                                                        >
                                                                                <span>{line.words.map((w: { word: string }) => w.word).join(" ") || line.romanLyric || line.translatedLyric}</span>
                                                                        </div>
                                                                );
                                                        })}
                                                </div>
                                        );
                                })}
                                {soloRows.map((line) => {
                                        const on = nowMs >= line.startTime && nowMs <= line.endTime;
                                        return (
                                                <div
                                                        key={`solo-${line.id}`}
                                                        className={classNames(styles.bgRow, on ? styles.bgRowOn : styles.bgRowOff)}
                                                        style={{ bottom: "0px" }}
                                                >
                                                        <span>{line.words.map((w: { word: string }) => w.word).join(" ") || line.romanLyric || line.translatedLyric}</span>
                                                </div>
                                        );
                                })}
                        </div>
                </Card>
        );
});

export default AMLLWrapper;
