import { atomWithStorage } from "jotai/utils";

export enum SyncJudgeMode {
	FirstKeyDownTime = "first-keydown-time",
	FirstKeyDownTimeLegacy = "first-keydown-time-legacy",
	LastKeyUpTime = "last-keyup-time",
	MiddleKeyTime = "middle-key-time",
}

export enum LayoutMode {
	Simple = "simple",
	Advance = "advance",
}

export enum TranslationOutputMode {
	/** Apple Music 样式：逐行翻译/音译写入 `<head>` 的 `<iTunesMetadata>` 中 */
	AppleMusic = "apple-music",
	/** AMLL 样式：逐行翻译/音译写入为内嵌的 `x-translation` / `x-roman` */
	Amll = "amll",
}

/** 打轴界面音节卡片的多行显示模式 */
export enum SyncWordDisplayMode {
	/** 只显示原文音节 */
	Syllable = "syllable",
	/** 只显示逐字音译 */
	Roman = "roman",
	/** 音节 + 音译 */
	SyllableRoman = "syllable-roman",
	/** 音节 + 假名 */
	SyllableKana = "syllable-kana",
	/** 假名 + 音节 + 音译 三行显示 */
	All = "all",
}

export const latencyTestBPMAtom = atomWithStorage("latencyTestBPM", 120);

export const syncJudgeModeAtom = atomWithStorage(
	"syncJudgeMode",
	SyncJudgeMode.FirstKeyDownTime,
);

export const layoutModeAtom = atomWithStorage("layoutMode", LayoutMode.Simple);

export const translationOutputModeAtom = atomWithStorage(
	"translationOutputMode",
	TranslationOutputMode.AppleMusic,
);

export const showWordRomanizationInputAtom = atomWithStorage(
	"showWordRomanizationInput",
	false,
);

/** 打轴界面音节卡片显示模式（持久化），取代旧的 displayRomanizationInSync 布尔开关 */
export const syncWordDisplayModeAtom = atomWithStorage(
	"syncWordDisplayMode",
	SyncWordDisplayMode.Syllable,
);

export const showLineTranslationAtom = atomWithStorage(
	"showLineTranslation",
	true,
);

export const showLineRomanizationAtom = atomWithStorage(
	"showLineRomanization",
	true,
);

export const hideSubmitAMLLDBWarningAtom = atomWithStorage(
	"hideSubmitAMLLDBWarning",
	false,
);
export const generateNameFromMetadataAtom = atomWithStorage(
	"generateNameFromMetadata",
	true,
);

export const autosaveEnabledAtom = atomWithStorage("autosaveEnabled", true);
export const autosaveIntervalAtom = atomWithStorage("autosaveInterval", 10);
export const autosaveLimitAtom = atomWithStorage("autosaveLimit", 10);

export const defaultTtmlAuthorGithubAtom = atomWithStorage(
	"defaultTtmlAuthorGithub",
	"",
);

export const defaultTtmlAuthorGithubLoginAtom = atomWithStorage(
	"defaultTtmlAuthorGithubLogin",
	"",
);

export const showTimestampsAtom = atomWithStorage("showTimestamps", true);

export const highlightActiveWordAtom = atomWithStorage(
	"highlightActiveWord",
	true,
);

export const highlightErrorsAtom = atomWithStorage("highlightErrors", false);

export const smartFirstWordAtom = atomWithStorage("smartFirstWord", false);
export const smartLastWordAtom = atomWithStorage("smartLastWord", false);

export const enableAutoRomanizationPredictionAtom = atomWithStorage(
	"enableAutoRomanizationPrediction",
	false,
);

export { stretchAlgorithmAtom } from "$/modules/audio/states";
export type { StretchAlgorithm } from "$/modules/ffmpeg/types.ts";
