/**
 * @description 处理打开文件的逻辑
 */

import {
	type LyricLine,
	parseEslrc,
	parseLys,
	parseQrc,
	parseYrc,
} from "@applemusic-like-lyrics/lyric";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { uid } from "uid";
import { audioEngine } from "$/modules/audio/audio-engine";
import { getProjectList } from "$/modules/project/autosave/autosave";
import { applyDefaultTtmlAuthorMetadata } from "$/modules/project/logic/default-metadata";
import { getSuggestedTtmlFileName } from "$/modules/project/logic/metadata-filename";
import { isProjectMatch } from "$/modules/project/logic/project-match";
import {
	defaultTtmlAuthorGithubAtom,
	defaultTtmlAuthorGithubLoginAtom,
} from "$/modules/settings/states";
import { ttmlToAmll } from "$/modules/ttml-processor";
import { autoAlignLeadingSilence } from "$/modules/ttml-processor/leadingSilence";
import type { AmllLyricResult } from "$/modules/ttml-processor/types";
import { confirmDialogAtom, ttmlRepairDialogAtom } from "$/states/dialogs.ts";
import {
	isDirtyAtom,
	lyricLinesAtom,
	newLyricLinesAtom,
	projectIdAtom,
	saveFileNameAtom,
} from "$/states/main.ts";
import type { TTMLLyric, TTMLMetadata } from "$/types/ttml";
import { createLogger } from "$/utils/logger";
import { parseLrc } from "$/utils/parse-lrc";

const fileOpenerLogger = createLogger("FileOpener");

const LYRIC_PARSERS: Record<string, (text: string) => LyricLine[]> = {
	lrc: parseLrc,
	eslrc: parseEslrc,
	qrc: parseQrc,
	yrc: parseYrc,
	lys: parseLys,
};

const AUDIO_EXTENSIONS = new Set([
	"flac",
	"wav",
	"m4a",
	"alac",
	"ape",
	"mac",
	"wv",
	"tta",
	"tak",
	"aiff",
	"aif",
	"aifc",
	"mp3",
	"aac",
	"mp4",
	"ogg",
	"oga",
	"opus",
	"wma",
	"asf",
	"mpc",
	"mpp",
	"mp+",
	"dsf",
	"ac3",
	"eac3",
	"dts",
	"dtshd",
	"thd",
	"mlp",
	"mka",
	"amr",
	"rm",
	"ra",
	"au",
	"snd",
	"caf",
	"w64",
	"iff",
	"8svx",
]);

const mergeExtractedMetadata = (
	currentMetadata: TTMLMetadata[],
	extractedMetadata: TTMLMetadata[],
) => {
	let changed = false;
	for (const extracted of extractedMetadata) {
		const values = extracted.value
			.map((value) => value.trim())
			.filter((value) => value !== "");
		if (values.length === 0) continue;

		const current = currentMetadata.find((item) => item.key === extracted.key);
		if (!current) {
			currentMetadata.push({ key: extracted.key, value: values });
			changed = true;
			continue;
		}

		if (current.value.some((value) => value.trim() !== "")) continue;
		current.value = values;
		changed = true;
	}
	return changed;
};

export const useFileOpener = () => {
	const setNewLyricLines = useSetAtom(newLyricLinesAtom);
	const setLyricLines = useSetAtom(lyricLinesAtom);
	const setProjectId = useSetAtom(projectIdAtom);
	const setSaveFileName = useSetAtom(saveFileNameAtom);
	const setConfirmDialog = useSetAtom(confirmDialogAtom);
	const isDirty = useAtomValue(isDirtyAtom);
	const defaultTtmlAuthorGithub = useAtomValue(defaultTtmlAuthorGithubAtom);
	const defaultTtmlAuthorGithubLogin = useAtomValue(
		defaultTtmlAuthorGithubLoginAtom,
	);
	const setTtmlRepairDialog = useSetAtom(ttmlRepairDialogAtom);
	const { t } = useTranslation();

	const normalizeLyricLines = useCallback(
		(lyricLines: LyricLine[]): TTMLLyric => {
			return {
				lyricLines: lyricLines.map((line) => ({
					...line,
					words: line.words.map((word) => ({
						...word,
						id: uid(),
						obscene: false,
						emptyBeat: 0,
					})),
					ignoreSync: false,
					id: uid(),
				})),
				metadata: [],
			};
		},
		[],
	);

	const normalizeAmllLyricResult = useCallback(
		(amllResult: AmllLyricResult): TTMLLyric => {
			return {
				metadata: amllResult.metadata.map((meta) => ({ ...meta })),
				lyricLines: amllResult.lyricLines.map((line) => ({
					...line,
					words: line.words.map((word) => ({
						...word,
						id: uid(),
						obscene: word.obscene ?? false,
						emptyBeat: word.emptyBeat ?? 0,
					})),
					ignoreSync: false,
					id: uid(),
				})),
			};
		},
		[],
	);

	const performOpenFile = useCallback(
		async (file: File, forceExt?: string) => {
			const rawExt = file.name.split(".").pop()?.toLowerCase() || "";
			const ext = forceExt ? forceExt.toLowerCase() : rawExt;

			try {
				if (AUDIO_EXTENSIONS.has(ext)) {
					void audioEngine
						.loadMusic(file)
						.then((metadata) => {
							setLyricLines((prev) => {
								const nextMetadata = prev.metadata.map((item) => ({
									...item,
									value: [...item.value],
								}));
								const metadataChanged = mergeExtractedMetadata(
									nextMetadata,
									metadata,
								);
								const defaultChanged = applyDefaultTtmlAuthorMetadata(
									nextMetadata,
									{
										githubId: defaultTtmlAuthorGithub,
										githubLogin: defaultTtmlAuthorGithubLogin,
									},
								);

								if (!metadataChanged && !defaultChanged) return prev;
								return { ...prev, metadata: nextMetadata };
							});
						})
						.catch((e) => {
							fileOpenerLogger.error(
								`Failed to load audio or extract metadata: ${file.name}`,
								e,
							);
						});
					return;
				}

				let lyricData: TTMLLyric | null = null;
				const text = await file.text();

				if (ext === "ttml") {
					// 导入前检测并自动修复「音译时间轴因 leadingSilence 相对正文的整体偏移」，
					// 这类文件虽能解析，但逐字音译会因错位而全部为空
					const align = autoAlignLeadingSilence(text);
					if (align.applied && align.offsetMs != null) {
						fileOpenerLogger.info(
							`Auto-aligned transliteration timeline: shifted ${align.shiftedSpanCount} spans by ${-align.offsetMs}ms (leadingSilence=${align.leadingSilenceMs})`,
						);
						toast.info(
							t(
								"ttmlImport.leadingSilenceFixed",
								"检测到音译时间轴与正文相差 {offset}ms，已自动对齐 {count} 个音译",
								{
									offset: align.offsetMs,
									count: align.shiftedSpanCount,
								},
							),
						);
					}
					const alignedText = align.text;
					const result = ttmlToAmll(alignedText);

					if (result.success) {
						lyricData = normalizeAmllLyricResult(result.data);
					} else {
						setTtmlRepairDialog({
							error: result.error,
							rawText: alignedText,
							onRepaired: (fixedText) => {
								const fixedFile = new File([fixedText], file.name, {
									type: "application/xml",
								});
								void performOpenFile(fixedFile, "ttml");
							},
						});

						return;
					}
				} else if (ext === "qrc") {
					// QRC → 本地服务端 Ruby TTML 转换
					// (逐字时间轴 + 假名注音 + 逐词罗马音 + 翻译)
					let serverError: string | null = null;
					let serverReachable = true;
					try {
						const resp = await fetch("/api/qrc-to-ttml", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ content: text }),
						});
						if (resp.ok) {
							const data = (await resp.json()) as {
								ttml?: string;
								error?: string;
								lineCount?: number;
								rubyWordCount?: number;
								hasRoma?: boolean;
								hasTrans?: boolean;
							};
							if (data.ttml) {
								const result = ttmlToAmll(data.ttml);
								if (result.success) {
									lyricData = normalizeAmllLyricResult(result.data);
									const feats = [
										data.rubyWordCount
											? t("qrcImport.featRuby", "假名注音")
											: "",
										data.hasRoma ? t("qrcImport.featRoma", "罗马音") : "",
										data.hasTrans ? t("qrcImport.featTrans", "翻译") : "",
									]
										.filter(Boolean)
										.join(t("qrcImport.featSep", "、"));
									toast.success(
										t("qrcImport.success", "QRC 转换成功：{lines} 行", {
											lines: data.lineCount ?? lyricData.lyricLines.length,
										}) + (feats ? `（${feats}）` : ""),
									);
								} else {
									serverError = t(
										"qrcImport.parseFailed",
										"转换后的 TTML 解析失败",
									);
								}
							} else {
								serverError = String(
									data.error ?? t("qrcImport.parseFailed", "转换失败"),
								);
							}
						} else {
							const data = (await resp.json().catch(() => ({}))) as {
								error?: string;
							};
							serverError = String(data.error ?? `HTTP ${resp.status}`);
						}
					} catch {
						serverReachable = false;
					}
					if (!lyricData) {
						// 服务端不可用 (如 file:// 直开) 或转换失败时,
						// 退回客户端基础解析 (仅逐字时间轴, 无注音)
						try {
							const rawLines = parseQrc(text);
							if (rawLines.length > 0) {
								lyricData = normalizeLyricLines(rawLines);
								if (serverReachable) {
									toast.info(
										t(
											"qrcImport.fallback",
											"已按基础 QRC 导入（不含注音与罗马音）",
										),
									);
								}
							}
						} catch {
							// 客户端也解析失败
						}
					}
					if (!lyricData) {
						toast.error(
							serverError ??
								t("error.unsupportedFileFormat", "不支持的文件格式: {ext}", {
									ext,
								}),
						);
						return;
					}
				} else if (ext in LYRIC_PARSERS) {
					const parser = LYRIC_PARSERS[ext];
					const rawLines = parser(text);
					lyricData = normalizeLyricLines(rawLines);
				} else {
					toast.error(
						t("error.unsupportedFileFormat", "不支持的文件格式: {ext}", {
							ext,
						}),
					);
					return;
				}

				if (!lyricData) return;

				let resolvedProjectId = uid();

				try {
					if (lyricData.metadata.length > 0) {
						const projects = await getProjectList();
						const matchedProject = projects.find((p) =>
							isProjectMatch(p, lyricData as TTMLLyric),
						);

						if (matchedProject) {
							fileOpenerLogger.debug(
								`匹配到了已有项目: ${matchedProject.name} (${matchedProject.id})`,
							);
							resolvedProjectId = matchedProject.id;
						} else {
							fileOpenerLogger.debug("未匹配已有项目");
						}
					}
				} catch (e) {
					fileOpenerLogger.error("解析项目数据时失败", e);
				}

				applyDefaultTtmlAuthorMetadata(lyricData.metadata, {
					githubId: defaultTtmlAuthorGithub,
					githubLogin: defaultTtmlAuthorGithubLogin,
				});

				setProjectId(resolvedProjectId);
				setNewLyricLines(lyricData);
				const suggestedFile = getSuggestedTtmlFileName(lyricData.metadata);
				const nextFileName =
					ext === "ttml"
						? file.name
						: ext === "qrc"
							? (suggestedFile?.fileName ??
								file.name.replace(/\.qrc$/i, ".ttml"))
							: (suggestedFile?.fileName ?? file.name);
				setSaveFileName(nextFileName);
			} catch (e) {
				fileOpenerLogger.error(`Failed to open file: ${file.name}`, e);
				toast.error(t("error.openFileFailed", "打开文件失败"));
			}
		},
		[
			setNewLyricLines,
			setLyricLines,
			setProjectId,
			setSaveFileName,
			normalizeLyricLines,
			normalizeAmllLyricResult,
			defaultTtmlAuthorGithub,
			defaultTtmlAuthorGithubLogin,
			t,
			setTtmlRepairDialog,
		],
	);

	const openFile = useCallback(
		/**
		 * 打开文件
		 * @param file
		 * @param forceExt 可选参数，用于强制指定解析方式，不传入则从文件后缀名推断
		 */
		(file: File, forceExt?: string) => {
			const run = () => performOpenFile(file, forceExt);

			const rawExt = file.name.split(".").pop()?.toLowerCase() || "";
			const finalExt = forceExt || rawExt;

			if (AUDIO_EXTENSIONS.has(finalExt)) {
				run();
				return;
			}

			if (isDirty) {
				setConfirmDialog({
					open: true,
					title: t("confirmDialog.openFile.title", "确认打开文件"),
					description: t(
						"confirmDialog.openFile.description",
						"当前文件有未保存的更改。如果继续，这些更改将会丢失。确定要打开新文件吗？",
					),
					onConfirm: run,
				});
			} else {
				run();
			}
		},
		[isDirty, setConfirmDialog, t, performOpenFile],
	);

	return { openFile };
};
