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
import { memo, useEffect, useMemo, useRef } from "react";
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
import styles from "./index.module.css";

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

        const lyricLines = useMemo(() => {
                return structuredClone(
                        originalLyricLines.lyricLines.map((line) => ({
                                ...line,
                                translatedLyric: showTranslationLines ? line.translatedLyric : "",
                                romanLyric: showRomanLines ? line.romanLyric : "",
                        })),
                );
        }, [originalLyricLines, showTranslationLines, showRomanLines]);
        
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
                        if (playerRef.current?.lyricPlayer) {
                                playerRef.current.lyricPlayer.setCurrentTime(timeInSeconds * 1000);
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
                        )}
                >
                        <LyricPlayer
                                style={{
                                        height: "100%",
                                        boxSizing: "content-box",
                                }}
                                onLyricLineClick={(evt) => {
                                        playerRef.current?.lyricPlayer?.resetScroll();
                                        audioEngine.seekMusic(evt.line.getLine().startTime / 1000);
                                }}
                                lyricLines={lyricLines}
                                playing={isPlaying}
                                // maskObsceneWordsMode={
                                //      hideObsceneWords
                                //              ? MaskObsceneWordsMode.FullMask
                                //              : MaskObsceneWordsMode.Disabled
                                // }
                                wordFadeWidth={wordFadeWidth}
                                ref={playerRef}
                        />
                </Card>
        );
});

export default AMLLWrapper;
