import {
        TranslationOutputMode,
        translationOutputModeAtom,
} from "$/modules/settings/states";
import { globalStore } from "$/states/store.ts";
import type {
        LyricLine as AppLyricLine,
        LyricWord as AppLyricWord,
        TTMLLyric as AppTTMLLyric,
        TTMLMetadata as AppTTMLMetadata,
} from "$/types/ttml";
import type {
        AmllLyricLine,
        AmllLyricResult,
        AmllLyricWord,
        AmllMetadata,
        AmllToTtmlOptions,
        GeneratorConfig,
        JsError,
        TTMLResult,
        TtmlToAmllOptions,
} from "./types";
import {
        amllToTtml as rawAmllToTtml,
        amllToTtmlResult as rawAmllToTtmlResult,
        generateTtml as rawGenerateTtml,
        parseTtml as rawParseTtml,
        ttmlResultToAmll as rawTtmlResultToAmll,
        ttmlToAmll as rawTtmlToAmll,
} from "./wasm/ttml_processor_wasm";

export {
        autoAlignLeadingSilence,
        type LeadingSilenceFixResult,
} from "./leadingSilence";

//#region 类型定义
export type Result<T> =
        | { success: true; data: T }
        | { success: false; error: JsError };

/** 需要在导入时剔除的元数据键 */
const IGNORED_METADATA_KEYS = new Set(["timingMode", "language"]);

/** 导入时需要重命名的元数据键 */
const RENAMED_METADATA_KEYS: Record<string, string> = {
        songwriters: "songwriter",
        title: "musicName",
};

/** 导出时需要重命名的元数据键 */
const EXPORT_RENAMED_METADATA_KEYS: Record<string, string> = {
        songwriter: "songwriters",
};
//#endregion

//#region 生成器配置
/**
 * 根据首选项中的翻译输出方式，生成默认的 TTML 生成器配置
 *
 * - {@link TranslationOutputMode.AppleMusic}：逐行翻译/音译写入 `<iTunesMetadata>`
 * - {@link TranslationOutputMode.Amll}：逐行翻译/音译写入为内嵌的
 *   `x-translation` / `x-roman`
 */
export function getDefaultGeneratorConfig(): Partial<GeneratorConfig> {
        return {
                useAppleFormatRules:
                        globalStore.get(translationOutputModeAtom) ===
                        TranslationOutputMode.AppleMusic,
        };
}

/**
 * 将调用方传入的生成器配置与首选项中的默认配置合并
 *
 * 调用方显式指定的字段优先于首选项
 */
function withDefaultGeneratorConfig(
        config?: Partial<GeneratorConfig>,
): Partial<GeneratorConfig> {
        return { ...getDefaultGeneratorConfig(), ...config };
}
//#endregion

//#region Ruby 兼容性预处理
/**
 * 兼容部分工具导出的简化 ruby 注音格式。
 *
 * Apple TTML 规范要求 ruby 注音文本嵌套在 tts:ruby="textContainer" 元素内：
 * <span tts:ruby="container">
 *   <span tts:ruby="base">恋</span>
 *   <span tts:ruby="textContainer">
 *     <span tts:ruby="text">こい</span>
 *   </span>
 * </span>
 *
 * 部分工具导出的简化格式把 tts:ruby="text" 直接放在 container 下，
 * 导致 ttml-processor 无法识别其中的假名。此函数在解析前为这类
 * 直接子级 text span 补上 textContainer 包装层。
 * 已符合规范的 container 会被跳过，不会双重包装。
 */
function normalizeRubyTextContainers(ttmlContent: string): string {
        if (!ttmlContent.includes('tts:ruby="container"')) return ttmlContent;

        const edits: Array<{ pos: number; text: string }> = [];
        const tagRe = /<(\/?)span\b([^>]*?)\/?>/g;

        // 收集全部 container 开标签位置
        const containerOpens: number[] = [];
        for (let m = tagRe.exec(ttmlContent); m !== null; m = tagRe.exec(ttmlContent)) {
                if (m[1] === "" && !m[0].endsWith("/>") && /tts:ruby="container"/.test(m[2])) {
                        containerOpens.push(m.index);
                }
        }

        for (const containerStart of containerOpens) {
                const openTagEnd = ttmlContent.indexOf(">", containerStart) + 1;
                const childRe = /<(\/?)span\b([^>]*?)\/?>/g;
                childRe.lastIndex = openTagEnd;
                let depth = 1;
                let curChildIsText = false;
                let hasTextContainer = false;
                let groupStart = -1;
                let groupEnd = -1;
                const groups: Array<{ start: number; end: number }> = [];

                const finalizeGroup = () => {
                        if (groupStart >= 0 && groupEnd >= 0) {
                                groups.push({ start: groupStart, end: groupEnd });
                        }
                        groupStart = -1;
                        groupEnd = -1;
                };

                for (
                        let t = childRe.exec(ttmlContent);
                        t !== null;
                        t = childRe.exec(ttmlContent)
                ) {
                        if (t[1] === "/") {
                                depth--;
                                if (depth === 0) {
                                        finalizeGroup();
                                        break;
                                }
                                if (depth === 1) {
                                        if (curChildIsText) {
                                                groupEnd = t.index + t[0].length;
                                        } else {
                                                finalizeGroup();
                                        }
                                }
                        } else if (!t[0].endsWith("/>")) {
                                if (depth === 1) {
                                        if (/tts:ruby="textContainer"/.test(t[2])) {
                                                hasTextContainer = true;
                                        }
                                        curChildIsText = /tts:ruby="text"/.test(t[2]);
                                        if (curChildIsText && groupStart < 0) {
                                                groupStart = t.index;
                                        }
                                }
                                depth++;
                        }
                }

                if (hasTextContainer) continue;

                for (const g of groups) {
                        edits.push({ pos: g.start, text: '<span tts:ruby="textContainer">' });
                        edits.push({ pos: g.end, text: "</span>" });
                }
        }

        if (edits.length === 0) return ttmlContent;

        // 从后往前应用，保证插入位置不失效
        edits.sort((a, b) => b.pos - a.pos);
        let result = ttmlContent;
        for (const e of edits) {
                result = result.slice(0, e.pos) + e.text + result.slice(e.pos);
        }
        return result;
}
//#endregion

//#region TTML 自动修复
/**
 * 常见 HTML 命名实体到 Unicode 码位的映射
 *
 * XML 只预定义了 amp / lt / gt / quot / apos 五个实体，
 * 歌词文本中常见的 &nbsp; 等 HTML 实体会导致解析失败
 */
const HTML_ENTITY_CODEPOINTS: Record<string, number> = {
        nbsp: 160, copy: 169, reg: 174, trade: 8482, hellip: 8230,
        mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220,
        rdquo: 8221, laquo: 171, raquo: 187, times: 215, divide: 247,
        middot: 183, bull: 8226, dagger: 8224, Dagger: 8225, prime: 8242,
        Prime: 8243, frac12: 189, frac14: 188, frac34: 190, sup2: 178,
        sup3: 179, deg: 176, para: 182, sect: 167, plusmn: 177, micro: 181,
        curren: 164, pound: 163, yen: 165, euro: 8364, cent: 162,
        ne: 8800, le: 8804, ge: 8805, infin: 8734, minus: 8722,
};

export interface TtmlRepairResult {
        /** 修复后的 TTML 文本 */
        text: string;
        /** 已应用的修复项（内部记录用） */
        appliedFixes: string[];
}

/** 将毫秒数格式化为 hh:mm:ss.sss */
function formatMsToTimestamp(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const fraction = Math.round(ms - totalSeconds * 1000);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(fraction).padStart(3, "0")}`;
}

/**
 * 将时间戳属性值规范化为 'hh:mm:ss.sss' 格式
 *
 * 支持修复：mm:ss.sss 缺少小时段、逗号小数点、缺失毫秒段、
 * 帧计数格式 (hh:mm:ss:frames) 以及 offset-time (如 500ms / 12.5s)
 * 无法识别的值返回 null 保持原样
 */
function normalizeTimestampValue(
        value: string,
        frameRate: number,
): string | null {
        let v = value.trim();
        if (v.length === 0) return null;
        // 欧式小数逗号 → 小数点
        v = v.replace(/,/g, ".");
        // offset-time 格式：500ms / 12.5s / 3m / 1h
        const offsetMatch = v.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
        if (offsetMatch) {
                const num = Number.parseFloat(offsetMatch[1]);
                const unit = offsetMatch[2];
                const ms =
                        unit === "ms"
                                ? num
                                : unit === "s"
                                  ? num * 1000
                                  : unit === "m"
                                    ? num * 60000
                                    : num * 3600000;
                return formatMsToTimestamp(ms);
        }
        if (!/^\d+([:.]\d+)*$/.test(v)) return null;
        let parts = v.split(":");
        if (parts.length === 1) return null; // 纯秒数格式不处理
        if (parts.length === 2) parts = ["0", ...parts]; // mm:ss.sss → hh:mm:ss.sss
        if (parts.length > 3) {
                // 帧计数格式 hh:mm:ss:frames → 按帧率折算为小数秒
                const frames = Number.parseFloat(parts[3]) || 0;
                const seconds = Number.parseFloat(parts[2]) || 0;
                parts = parts.slice(0, 3);
                parts[2] = (seconds + frames / frameRate).toFixed(3);
        }
        // 规范秒的小数部分为三位
        const secondsPart = parts[2];
        if (secondsPart.includes(".")) {
                const [intPart, fracPart] = secondsPart.split(".");
                parts[2] = `${intPart}.${(fracPart + "000").slice(0, 3)}`;
        } else {
                parts[2] = `${secondsPart}.000`;
        }
        // 补齐时分秒为两位数字
        return parts
                .map((p, i) => {
                        if (i < 2) return p.padStart(2, "0");
                        const [intPart, fracPart] = p.split(".");
                        return `${intPart.padStart(2, "0")}.${fracPart}`;
                })
                .join(":");
}

/** 为未闭合的标签补上结束标签（处理文件截断等场景） */
function autoCloseUnclosedTags(text: string): string {
        // 仅用于分析标签栈：剔除注释、处理指令与 CDATA，避免伪标签干扰
        const cleaned = text
                .replace(/<!--[\s\S]*?-->/g, "")
                .replace(/<\?[\s\S]*?\?>/g, "")
                .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
        const tagRe = /<(\/)?([a-zA-Z][\w.:-]*)(?:"[^"]*"|'[^']*'|[^"'>])*>/g;
        const stack: string[] = [];
        for (const m of cleaned.matchAll(tagRe)) {
                const isClose = Boolean(m[1]);
                const name = m[2];
                if (isClose) {
                        const idx = stack.lastIndexOf(name);
                        if (idx !== -1) stack.length = idx;
                } else if (!m[0].endsWith("/>")) {
                        stack.push(name);
                }
        }
        if (stack.length === 0) return text;
        return text + stack.reverse().map((n) => `</${n}>`).join("");
}

/**
 * 尝试自动修正常见的 TTML 格式问题
 *
 * 目前会尝试修复：
 * - 文件头的 BOM 与非法控制字符
 * - XML 不兼容的 HTML 命名实体（如 &nbsp;）转换为数字实体
 * - 裸露的 & 转义为 &amp;
 * - begin / end / dur 属性中的时间戳规范化
 * - 未闭合的标签自动补齐
 *
 * 修复不保证语义完全正确（尤其是自动补齐标签的位置），
 * 仅作为导入失败时的兜底手段
 */
export function repairTTML(ttmlContent: string): TtmlRepairResult {
        let text = ttmlContent;
        const fixes: string[] = [];

        // 1. BOM 与非法控制字符
        const stripped = text
                .replace(/^\uFEFF/, "")
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
        if (stripped !== text) {
                fixes.push("removed BOM or control characters");
                text = stripped;
        }

        // 2. 不兼容的 HTML 命名实体 → 数字实体
        const entityFixed = text.replace(
                /&([a-zA-Z][a-zA-Z0-9]*);/g,
                (m, name: string) => {
                        if (["amp", "lt", "gt", "quot", "apos"].includes(name)) return m;
                        const code = HTML_ENTITY_CODEPOINTS[name];
                        return code ? `&#${code};` : m;
                },
        );
        if (entityFixed !== text) {
                fixes.push("converted HTML named entities");
                text = entityFixed;
        }

        // 3. 裸露的 & 转义为 &amp;
        const ampFixed = text.replace(
                /&(?!(?:#[0-9]+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);)/g,
                "&amp;",
        );
        if (ampFixed !== text) {
                fixes.push("escaped bare ampersands");
                text = ampFixed;
        }

        // 4. 时间戳规范化（帧率取自 ttp:frameRate，默认 30）
        const frameRateMatch = text.match(/ttp:frameRate\s*=\s*"(\d+(?:\.\d+)?)"/);
        const frameRate = Number.parseFloat(frameRateMatch?.[1] ?? "30") || 30;
        const tsFixed = text.replace(
                /\b(begin|end|dur)\s*=\s*"([^"]*)"/g,
                (m, attr: string, val: string) => {
                        const fixed = normalizeTimestampValue(val, frameRate);
                        return fixed && fixed !== val ? `${attr}="${fixed}"` : m;
                },
        );
        if (tsFixed !== text) {
                fixes.push("normalized timestamps");
                text = tsFixed;
        }

        // 5. 移除文件末尾被截断的不完整标签
        //    （例如文件在属性值中间被切断: <span begin="0:00:16.2…）
        const lastGt = text.lastIndexOf(">");
        const lastLt = text.lastIndexOf("<");
        if (lastLt > lastGt) {
                text = text.slice(0, lastLt);
                fixes.push("removed truncated trailing fragment");
        }

        // 6. 补齐未闭合的标签
        const closed = autoCloseUnclosedTags(text);
        if (closed !== text) {
                fixes.push("closed unclosed tags");
                text = closed;
        }

        return { text, appliedFixes: fixes };
}
//#endregion

//#region 底层 API
/**
 * 解析 TTML 字符串为 TTMLResult
 * @param ttmlContent 原始 TTML 文本
 * @returns Result 包含 TTMLResult
 */
export function parseTTML(ttmlContent: string): Result<TTMLResult> {
        return rawParseTtml(
                normalizeRubyTextContainers(ttmlContent),
        ) as Result<TTMLResult>;
}

/**
 * 将解析后的 TTML 结构体生成为 TTML 字符串
 * @param result TTMLResult 数据模型
 * @param config TTML 生成器配置
 * @returns Result 包含生成的 TTML 字符串
 */
export function generateTTML(
        result: TTMLResult,
        config?: Partial<GeneratorConfig>,
): Result<string> {
        return rawGenerateTtml(result, config) as Result<string>;
}
//#endregion

//#region AMLL 转换相关
/**
 * 便捷方法，将 TTML 字符串转换并降级为 AMLL 所使用的较简单的结构
 * @param ttmlContent 原始 TTML 文本
 * @param options 提取时的语言首选项
 * @returns Result 包含 AmllLyricResult
 */
export function ttmlToAmll(
        ttmlContent: string,
        options?: Partial<TtmlToAmllOptions>,
): Result<AmllLyricResult> {
        const result = rawTtmlToAmll(
                normalizeRubyTextContainers(ttmlContent),
                options,
        ) as Result<AmllLyricResult>;
        if (!result.success) return result;

        const processedLyricLines = result.data.lyricLines.map((line) => {
                const newWords: AmllLyricWord[] = [];

                for (const word of line.words) {
                        const trailingSpaceMatch = word.word.match(/(\s+)$/);

                        if (trailingSpaceMatch && word.word !== trailingSpaceMatch[0]) {
                                const spaces = trailingSpaceMatch[0];
                                const pureWord = word.word.slice(0, -spaces.length);

                                newWords.push({ ...word, word: pureWord });

                                newWords.push({
                                        startTime: 0,
                                        endTime: 0,
                                        word: spaces,
                                });
                        } else {
                                newWords.push(word);
                        }
                }

                return {
                        ...line,
                        words: newWords,
                };
        });

        return {
                success: true,
                data: {
                        ...result.data,
                        lyricLines: processedLyricLines,
                        metadata: result.data.metadata
                                .filter((meta) => !IGNORED_METADATA_KEYS.has(meta.key))
                                .map((meta) => ({
                                        ...meta,
                                        key: RENAMED_METADATA_KEYS[meta.key] ?? meta.key,
                                })),
                },
        };
}

/**
 * 将编辑器内部的单个歌词单词降级为 AMLL 简化结构
 *
 * 会丢弃 `id`、`romanWarning` 等编辑器专用字段
 */
function normalizeExportWord(word: AppLyricWord): AmllLyricWord {
        return {
                startTime: word.startTime,
                endTime: word.endTime,
                word: word.word,
                romanWord: word.romanWord,
                obscene: word.obscene,
                emptyBeat: word.emptyBeat,
                ruby: word.ruby,
        };
}

/**
 * 将编辑器内部的单行歌词降级为 AMLL 简化结构
 *
 * 会丢弃 `id`、`ignoreSync`、`endTimeLink` 等编辑器专用字段
 */
function normalizeExportLine(line: AppLyricLine): AmllLyricLine {
        return {
                words: line.words.map(normalizeExportWord),
                translatedLyric: line.translatedLyric,
                romanLyric: line.romanLyric,
                isBG: line.isBG,
                isDuet: line.isDuet,
                startTime: line.startTime,
                endTime: line.endTime,
        };
}

/**
 * 将编辑器内部的元数据降级为 AMLL 简化结构
 */
function normalizeExportMetadata(metadata: AppTTMLMetadata[]): AmllMetadata[] {
        return metadata.map((meta) => ({
                key: EXPORT_RENAMED_METADATA_KEYS[meta.key] ?? meta.key,
                value: [...meta.value],
        }));
}

/**
 * 将编辑器内部使用的 `TTMLLyric` 结构转换为 AMLL 所使用的较简单的结构
 * @param ttmlLyric 编辑器内部的歌词数据
 * @returns AmllLyricResult 结构
 */
export function ttmlLyricToAmllResult(
        ttmlLyric: AppTTMLLyric,
): AmllLyricResult {
        return {
                lyricLines: ttmlLyric.lyricLines.map(normalizeExportLine),
                metadata: normalizeExportMetadata(ttmlLyric.metadata),
        };
}

function postProcessLyricLines(amllResult: AmllLyricResult): AmllLyricResult {
        return {
                ...amllResult,
                lyricLines: amllResult.lyricLines.map((line) => ({
                        ...line,
                        startTime: Math.round(line.startTime),
                        endTime: Math.round(line.endTime),
                        words: line.words.map((word) => {
                                const processedWord: AmllLyricWord = {
                                        ...word,
                                        startTime: Math.round(word.startTime),
                                        endTime: Math.round(word.endTime),
                                        ruby: word.ruby
                                                ? word.ruby.map((r) => ({
                                                                ...r,
                                                                startTime: Math.round(r.startTime),
                                                                endTime: Math.round(r.endTime),
                                                        }))
                                                : undefined,
                                };

                                if (processedWord.emptyBeat == null || processedWord.emptyBeat === 0) {
                                        processedWord.emptyBeat = undefined;
                                }

                                if (!processedWord.romanWord || processedWord.romanWord.trim() === "") {
                                        processedWord.romanWord = undefined;
                                }

                                return processedWord;
                        }),
                })),
        };
}

/**
 * 判断给定的歌词是否为逐行歌词
 *
 * 如果所有非背景人声的歌词行都只有一个音节，则判定为逐行歌词
 */
export function isLineTimingLyrics(
        lyric: AmllLyricResult | AppTTMLLyric,
): boolean {
        const nonBgLines = lyric.lyricLines.filter((line) => !line.isBG);
        return (
                nonBgLines.length > 0 && nonBgLines.every((line) => line.words.length === 1)
        );
}

/**
 * 便捷方法，将 AMLL 格式的歌词和元数据生成为 TTML 字符串
 *
 * 会对文本进行规范化，例如清理空格、移除背景人声括号等
 * @param amllResult AMLL 结构体数据
 * @param options 语言配置
 * @param config TTML 生成器配置
 * @returns Result 包含生成的 TTML 字符串
 */
export function amllToTTML(
        amllResult: AmllLyricResult,
        options?: Partial<AmllToTtmlOptions>,
        config?: Partial<GeneratorConfig>,
): Result<string> {
        const processedAmllResult = postProcessLyricLines(amllResult);
        const lineTiming = isLineTimingLyrics(amllResult);
        return rawAmllToTtml(
                processedAmllResult,
                options,
                withDefaultGeneratorConfig({
                        lineTiming,
                        ...config,
                }),
        ) as Result<string>;
}

/**
 * 工具方法，将复杂的 TTMLResult 结构降级为 AMLL 所使用的较简单的数据结构
 * @param ttmlResult 复杂的 TTMLResult 数据树
 * @param options 提取时的语言首选项
 * @returns Result 包含 AmllLyricResult
 */
export function ttmlResultToAmll(
        ttmlResult: TTMLResult,
        options?: Partial<TtmlToAmllOptions>,
): Result<AmllLyricResult> {
        return rawTtmlResultToAmll(ttmlResult, options) as Result<AmllLyricResult>;
}

/**
 * 工具方法，将 AMLL 格式的歌词和元数据转换为 TTMLResult 结构
 *
 * 会对文本进行规范化，例如清理空格、移除背景人声括号等
 * @param amllResult AMLL 结构体数据
 * @param options 语言配置
 * @returns Result 包含 TTMLResult
 */
export function amllToTTMLResult(
        amllResult: AmllLyricResult,
        options?: Partial<AmllToTtmlOptions>,
): Result<TTMLResult> {
        const processedAmllResult = postProcessLyricLines(amllResult);
        return rawAmllToTtmlResult(
                processedAmllResult,
                options,
        ) as Result<TTMLResult>;
}
//#endregion
