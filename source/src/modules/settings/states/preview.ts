import { atomWithStorage } from "jotai/utils";

export const showTranslationLinesAtom = atomWithStorage(
        "showTranslationLines",
        false,
);
export const showRomanLinesAtom = atomWithStorage("showRomanLines", false);
/**
 * 预览界面中交换翻译行与音译行的上下位置
 *
 * 默认情况下 AMLL 播放器在主歌词行下方先渲染翻译行、再渲染音译行，
 * 开启后两者位置互换（音译在上、翻译在下）
 */
export const swapRomanTranslationAtom = atomWithStorage(
        "swapRomanTranslation",
        false,
);
export const hideObsceneWordsAtom = atomWithStorage("hideObsceneWords", false);
export const lyricWordFadeWidthAtom = atomWithStorage(
        "lyricWordFadeWidth",
        0.5,
);
