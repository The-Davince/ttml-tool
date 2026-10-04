import * as wanakana from "wanakana";
import { uid } from "uid";
import { recordAIHistory } from "$/modules/history/states";
import { apiUrl } from "$/modules/ai/states";
import { ttmlToAmll } from "$/modules/ttml-processor";
import { lyricLinesAtom } from "$/states/main.ts";
import { globalStore } from "$/states/store.ts";
import {
        type LyricLine,
        type LyricWord,
        newLyricLine,
        newLyricWord,
        type TTMLLyric,
        type TTMLMetadata,
} from "$/types/ttml";

/**
 * AI 工具注册表（类 MCP）
 *
 * 每个工具声明 JSON Schema 参数与执行器；Agent 将这些定义
 * 发送给大模型，模型通过 function calling 调用，
 * 执行结果回传给模型继续决策。
 *
 * 所有修改歌词的工具：
 * - 通过 globalStore 直接写入 lyricLinesAtom（自动获得 Ctrl+Z 撤销支持）
 * - 修改后调用 recordAIHistory 记录历史（AI 来源，精确描述）
 */

export interface AgentToolResult {
        success: boolean;
        message: string;
        data?: unknown;
}

export interface AgentTool {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        execute: (
                args: Record<string, unknown>,
        ) => Promise<AgentToolResult> | AgentToolResult;
}

const getLyric = (): TTMLLyric => globalStore.get(lyricLinesAtom);

const setLyric = (lyric: TTMLLyric) => {
        globalStore.set(lyricLinesAtom, lyric);
};

const ok = (message: string, data?: unknown): AgentToolResult => ({
        success: true,
        message,
        data,
});

const fail = (message: string): AgentToolResult => ({
        success: false,
        message,
});

const asNumberArray = (v: unknown): number[] =>
        Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [];

/** 行号校验，返回有效索引或 null */
const validLineIndex = (i: number, lines: LyricLine[]) =>
        Number.isInteger(i) && i >= 0 && i < lines.length;

const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

const getLyricsInfo: AgentTool = {
        name: "get_lyrics_info",
        description:
                "获取当前歌词文档的结构概览：元数据（歌名歌手）、每行的行号、歌词文本、音节数、时间范围、假名/翻译/音译状态。修改歌词前建议先调用。",
        parameters: { type: "object", properties: {}, required: [] },
        execute: () => {
                const lyric = getLyric();
                const meta: Record<string, string> = {};
                for (const m of lyric.metadata) {
                        if (m.value.length > 0) meta[m.key] = m.value.join(" / ");
                }
                const MAX_LINES = 120;
                const lines = lyric.lyricLines.slice(0, MAX_LINES).map((line, i) => {
                        const text = line.words.map((w) => w.word).join("");
                        return {
                                line: i,
                                text: text.length > 60 ? `${text.slice(0, 60)}…` : text,
                                syllables: line.words.length,
                                start: formatSeconds(line.startTime),
                                end: formatSeconds(line.endTime),
                                ruby: line.words.filter((w) => w.ruby && w.ruby.length > 0).length,
                                isBG: line.isBG,
                                translation: line.translatedLyric
                                        ? line.translatedLyric.slice(0, 30)
                                        : "",
                                roman: line.romanLyric ? line.romanLyric.slice(0, 30) : "",
                                words: line.words.slice(0, 20).map((w) => ({
                                        i: line.words.indexOf(w),
                                        text: w.word,
                                        ruby: w.ruby?.map((r) => r.word).join("") ?? "",
                                        roman: w.romanWord ?? "",
                                })),
                        };
                });
                return ok(`当前歌词：${lyric.lyricLines.length} 行`, {
                        metadata: meta,
                        totalLines: lyric.lyricLines.length,
                        truncated: lyric.lyricLines.length > MAX_LINES,
                        lines,
                });
        },
};

const searchWeb: AgentTool = {
        name: "search_web",
        description:
                "搜索互联网网页。用于查询歌曲信息、完整歌词、日语读音、歌手资料等。返回标题、链接与摘要。本地服务器会自动在多个搜索引擎间回退（Bing / DuckDuckGo），结果包含实际使用的引擎。",
        parameters: {
                type: "object",
                properties: {
                        query: { type: "string", description: "搜索关键词" },
                        maxResults: {
                                type: "number",
                                description: "返回结果数量，默认 6，最多 12",
                        },
                },
                required: ["query"],
        },
        execute: async (args) => {
                const query = String(args.query ?? "").trim();
                if (!query) return fail("缺少搜索关键词");
                const maxResults = Math.min(Math.max(Number(args.maxResults) || 6, 1), 12);
                const resp = await fetch(apiUrl("/api/web-search"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ query, maxResults }),
                });
                const data = await resp.json();
                if (!resp.ok || data.error)
                        return fail(String(data.error ?? `HTTP ${resp.status}`));
                const results = (data.results ?? []) as Array<{
                        title: string;
                        url: string;
                        snippet: string;
                }>;
                if (results.length === 0) {
                        const attempts = (data.attempts ?? []) as Array<{
                                engine: string;
                                ok: boolean;
                                error?: string;
                        }>;
                        const detail = attempts
                                .map((a) => `${a.engine}: ${a.ok ? "0 条结果" : (a.error ?? "失败")}`)
                                .join("；");
                        return fail(
                                detail
                                        ? `所有搜索引擎都未返回结果（${detail}）。可能是网络限制，建议改用 search_qq_music 查歌曲信息`
                                        : "没有找到相关结果，建议换个关键词",
                        );
                }
                const note =
                        data.relevance === "low" && data.hint
                                ? `（⚠ ${data.hint} 请基于当前结果尽快作答，最多再简化关键词重试一次，勿就同一实体反复多轮搜索；若是歌曲/歌手信息，改用 search_qq_music 按歌名或歌手名查。）`
                                : "";
                return ok(
                        `搜索“${query}”，找到 ${results.length} 条结果（引擎：${data.engine}）${note}`,
                        results,
                );
        },
};

interface QQSong {
        songMid: string;
        songId: string;
        name: string;
        singers: string;
        album: string;
        durationSec: number;
        songUrl: string;
}

const searchQQMusic: AgentTool = {
        name: "search_qq_music",
        description:
                "在 QQ 音乐曲库中搜索歌曲，返回 songMid、歌名、歌手、专辑、时长。找到 songMid 后可用 import_qq_lyric 直接导入该歌曲的官方歌词（逐字时间轴、假名、罗马音、翻译）。注意：关键词只用歌名或只用歌手名效果最好，不要把歌名和歌手拼在一起。",
        parameters: {
                type: "object",
                properties: {
                        query: {
                                type: "string",
                                description: "搜索关键词（歌名或歌手名，不要混用）",
                        },
                        maxResults: { type: "number", description: "返回数量，默认 8" },
                },
                required: ["query"],
        },
        execute: async (args) => {
                const query = String(args.query ?? "").trim();
                if (!query) return fail("缺少搜索关键词");
                const maxResults = Math.min(Math.max(Number(args.maxResults) || 8, 1), 20);
                const resp = await fetch(apiUrl("/api/qq-music-search"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ query, maxResults }),
                });
                const data = await resp.json();
                if (!resp.ok || data.error)
                        return fail(String(data.error ?? `HTTP ${resp.status}`));
                const results = (data.results ?? []) as QQSong[];
                if (results.length === 0) {
                        const attempts = (data.attempts ?? []) as Array<{
                                api: string;
                                ok: boolean;
                                error?: string;
                        }>;
                        const detail = attempts
                                .map((a) => `${a.api}: ${a.ok ? "0 条" : (a.error ?? "失败")}`)
                                .join("；");
                        return fail(
                                detail
                                        ? `QQ 音乐搜索未返回结果（${detail}）`
                                        : "QQ 音乐没有找到这首歌，建议换个关键词",
                        );
                }
                return ok(`QQ 音乐找到 ${results.length} 首歌`, results);
        },
};

interface QQLyricWord {
        word: string;
        start: number;
        end: number;
        ruby: string[];
}
interface QQLyricLine {
        start: number;
        end: number;
        words: QQLyricWord[];
        text: string;
        isCredit: boolean;
        translation: string;
        roman: string;
}
interface QQLyricResponse {
        wordTiming: boolean;
        meta: { ti?: string; ar?: string; al?: string };
        lines: QQLyricLine[];
        lineCount: number;
        creditCount: number;
        hasTranslation: boolean;
        hasRoma: boolean;
}

const importQQLyric: AgentTool = {
        name: "import_qq_lyric",
        description:
                "导入 QQ 音乐的官方歌词替换当前编辑器内容：自动包含逐字时间轴、假名注音、罗马音、中文翻译（视歌曲而定），并写入元数据（musicName/artists/album/qqMusicId/songwriter）。先用 search_qq_music 获得 songMid 再调用，建议把搜索结果里的 name/singers/album/songId 一并传入以获得更准确的元数据。导入会保留原文档中 QQ 未提供的元数据。",
        parameters: {
                type: "object",
                properties: {
                        songMid: {
                                type: "string",
                                description: "歌曲 songMid（来自 search_qq_music）",
                        },
                        name: {
                                type: "string",
                                description: "可选，歌名（来自搜索结果，写入 musicName）",
                        },
                        singers: {
                                type: "string",
                                description: "可选，歌手（来自搜索结果，写入 artists，多人用 / 分隔）",
                        },
                        album: {
                                type: "string",
                                description: "可选，专辑名（来自搜索结果，写入 album）",
                        },
                        songId: {
                                type: "string",
                                description: "可选，QQ 音乐数字 ID（来自搜索结果，写入 qqMusicId）",
                        },
                        includeCredits: {
                                type: "boolean",
                                description: "是否保留开头的制作名单行（词/曲/编曲等），默认不保留",
                        },
                },
                required: ["songMid"],
        },
        execute: async (args) => {
                const songMid = String(args.songMid ?? "").trim();
                if (!songMid) return fail("缺少 songMid 参数");
                const includeCredits = Boolean(args.includeCredits);
                const songInfo = {
                        name: String(args.name ?? "").trim(),
                        singers: String(args.singers ?? "").trim(),
                        album: String(args.album ?? "").trim(),
                        songId: String(args.songId ?? "").trim(),
                };
                const resp = await fetch(apiUrl("/api/qq-music-lyric"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                                songMid,
                                withTranslation: true,
                                includeCredits,
                                metaExtra: songInfo,
                        }),
                });
                const data = await resp.json();
                if (!resp.ok || data.error)
                        return fail(String(data.error ?? `HTTP ${resp.status}`));
                const lyricData = data as QQLyricResponse & { ttml?: string };

                const lyric = getLyric();

                // 新版服务端附带 Ruby TTML → 高保真导入
                // (逐假名时间轴注音 + 逐词音译 + 翻译, 制作名单已在服务端过滤)
                if (lyricData.ttml) {
                        const result = ttmlToAmll(lyricData.ttml);
                        if (result.success) {
                                const amll = result.data;
                                // 元数据合并: QQ 返回的键 (musicName/artists/album/qqMusicId/
                                // songwriter) 覆盖同名项, 原文档独有的键 (如 isrc) 保留
                                const qqKeys = new Set(amll.metadata.map((m) => m.key));
                                let metadata: TTMLMetadata[] = amll.metadata.map((m) => ({
                                        key: m.key,
                                        value: [...m.value],
                                }));
                                metadata = [
                                        ...metadata,
                                        ...structuredClone(lyric.metadata).filter(
                                                (m) => !qqKeys.has(m.key),
                                        ),
                                ];
                                const lines: LyricLine[] = amll.lyricLines.map((line) => ({
                                        ...line,
                                        words: line.words.map((word) => ({
                                                ...word,
                                                id: uid(),
                                                obscene: word.obscene ?? false,
                                                emptyBeat: word.emptyBeat ?? 0,
                                        })),
                                        ignoreSync: false,
                                        id: uid(),
                                }));
                                setLyric({ metadata, lyricLines: lines });
                                const title =
                                        metadata.find((m) => m.key === "musicName")?.value[0] ??
                                        songMid;
                                const feats = [
                                        "逐字时间轴",
                                        lines.some((l) => l.words.some((w) => w.ruby && w.ruby.length > 0))
                                                ? "假名注音"
                                                : "",
                                        lines.some((l) =>
                                                l.words.some((w) => w.romanWord && w.romanWord.trim()),
                                        )
                                                ? "罗马音"
                                                : "",
                                        lines.some((l) => l.translatedLyric) ? "翻译" : "",
                                ]
                                        .filter(Boolean)
                                        .join("、");
                                const desc = `导入 QQ 音乐歌词「${title}」（${lines.length} 行，${feats}）`;
                                recordAIHistory(desc);
                                return ok(desc, {
                                        lineCount: lines.length,
                                        wordTiming: true,
                                        hasRoma: lyricData.hasRoma,
                                        hasTranslation: lyricData.hasTranslation,
                                });
                        }
                }

                const sourceLines = lyricData.lines.filter(
                        (l) => includeCredits || !l.isCredit,
                );
                if (sourceLines.length === 0) return fail("该歌曲没有可导入的歌词行");

                const lines: LyricLine[] = sourceLines.map((sl) => {
                        const line = newLyricLine();
                        line.startTime = sl.start;
                        line.endTime = sl.end > sl.start ? sl.end : sl.start + 2000;
                        line.translatedLyric = sl.translation || "";
                        line.romanLyric = sl.roman || "";
                        for (const sw of sl.words) {
                                const word = newLyricWord();
                                word.word = sw.word;
                                word.startTime = sw.start;
                                word.endTime =
                                        sw.end > sw.start ? sw.end : Math.max(sl.end, sw.start + 100);
                                if (sw.ruby.length > 0) {
                                        const kana = sw.ruby;
                                        const span = word.endTime - word.startTime;
                                        word.ruby = kana.map((k, i) => ({
                                                word: k,
                                                startTime: word.startTime + (span * i) / kana.length,
                                                endTime: word.startTime + (span * (i + 1)) / kana.length,
                                        }));
                                }
                                line.words.push(word);
                        }
                        return line;
                });

                // 元数据：搜索结果优先，回退 QRC 头；键名与工具内建约定一致
                // (musicName/artists/album/qqMusicId)
                const cleanMeta = (v?: string) => {
                        const s = (v ?? "").replace(/\s+/g, " ").trim();
                        const m = s.match(/^(.+?)\s*[（(][^()（）]*[)）]\s*$/);
                        return (m ? m[1] : s).trim();
                };
                const titleVal = songInfo.name || cleanMeta(lyricData.meta.ti);
                const artistList = (
                        songInfo.singers || cleanMeta(lyricData.meta.ar) || ""
                )
                        .split(/\s*[/、，,]\s*/)
                        .filter(Boolean);
                const albumVal = songInfo.album || cleanMeta(lyricData.meta.al);
                const qqIdVal = songInfo.songId || songMid;
                const metaKeyMap: Array<[string[], string]> = [
                        [titleVal ? [titleVal] : [], "musicName"],
                        [artistList, "artists"],
                        [albumVal ? [albumVal] : [], "album"],
                        [[qqIdVal], "qqMusicId"],
                ];
                let metadata = structuredClone(lyric.metadata);
                for (const [values, key] of metaKeyMap) {
                        if (values.length === 0 || !values[0]) continue;
                        const existing = metadata.find((m) => m.key === key);
                        if (existing) existing.value = values;
                        else metadata = [...metadata, { key, value: values }];
                }

                setLyric({ metadata, lyricLines: lines });
                const title = titleVal || songMid;
                const feats = [
                        lyricData.wordTiming ? "逐字时间轴" : "行级时间轴",
                        lyricData.hasRoma ? "罗马音" : "",
                        lyricData.hasTranslation ? "翻译" : "",
                        lyricData.lines.some((l) => l.words.some((w) => w.ruby.length > 0))
                                ? "假名注音"
                                : "",
                ]
                        .filter(Boolean)
                        .join("、");
                const desc = `导入 QQ 音乐歌词「${title}」（${lines.length} 行，${feats}）`;
                recordAIHistory(desc);
                return ok(desc, {
                        lineCount: lines.length,
                        wordTiming: lyricData.wordTiming,
                        hasRoma: lyricData.hasRoma,
                        hasTranslation: lyricData.hasTranslation,
                });
        },
};

const readPage: AgentTool = {
        name: "read_page",
        description:
                "抓取指定网页的正文文本（配合 search_web 使用，获取网页里的详细内容，如完整歌词、假名标注等）。",
        parameters: {
                type: "object",
                properties: {
                        url: { type: "string", description: "网页链接（http/https）" },
                },
                required: ["url"],
        },
        execute: async (args) => {
                const url = String(args.url ?? "").trim();
                if (!/^https?:\/\//.test(url))
                        return fail("url 必须以 http:// 或 https:// 开头");
                const resp = await fetch(apiUrl("/api/fetch-page"), {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ url }),
                });
                const data = await resp.json();
                if (!resp.ok || data.error)
                        return fail(String(data.error ?? `HTTP ${resp.status}`));
                return ok(`已读取网页「${data.title || url}」`, {
                        title: data.title,
                        text: data.text,
                });
        },
};

const mergeLines: AgentTool = {
        name: "merge_lines",
        description:
                "合并多个歌词行为一行（按行号，合并到第一个行）。音节按顺序拼接，时间取并集，翻译/音译以空格连接。用于修复被错误拆分的行。",
        parameters: {
                type: "object",
                properties: {
                        lineIndices: {
                                type: "array",
                                items: { type: "number" },
                                description: "要合并的行号数组（从 0 开始），如 [3, 4, 5]",
                        },
                },
                required: ["lineIndices"],
        },
        execute: (args) => {
                const indices = asNumberArray(args.lineIndices);
                if (indices.length < 2) return fail("至少需要 2 个行号才能合并");
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                const uniq = [...new Set(indices)].sort((a, b) => a - b);
                for (const i of uniq) {
                        if (!validLineIndex(i, lines))
                                return fail(`行号 ${i} 超出范围（0-${lines.length - 1}）`);
                }
                const merged = { ...structuredClone(lines[uniq[0]]) };
                merged.words = [];
                merged.startTime = Math.min(...uniq.map((i) => lines[i].startTime));
                merged.endTime = Math.max(...uniq.map((i) => lines[i].endTime));
                const translations: string[] = [];
                const romans: string[] = [];
                for (const i of uniq) {
                        merged.words.push(...structuredClone(lines[i].words));
                        if (lines[i].translatedLyric) translations.push(lines[i].translatedLyric);
                        if (lines[i].romanLyric) romans.push(lines[i].romanLyric);
                }
                merged.translatedLyric = translations.join(" ");
                merged.romanLyric = romans.join(" ");
                const remove = new Set(uniq.slice(1));
                const nextLines = lines
                        .map((l, i) => (i === uniq[0] ? merged : remove.has(i) ? null : l))
                        .filter((l): l is LyricLine => l !== null);
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc =
                        uniq.length === 2
                                ? `合并第 ${uniq[0] + 1}-${uniq[1] + 1} 行`
                                : `合并 ${uniq.length} 行`;
                recordAIHistory(desc);
                return ok(desc, { newLineCount: nextLines.length });
        },
};

const mergeSyllables: AgentTool = {
        name: "merge_syllables",
        description:
                "合并一行内的多个音节（词）为一个。文本直接拼接、时间取并集、假名按顺序连接。用于修复过度拆分的音节。",
        parameters: {
                type: "object",
                properties: {
                        lineIndex: { type: "number", description: "行号（从 0 开始）" },
                        wordIndices: {
                                type: "array",
                                items: { type: "number" },
                                description: "要合并的音节序号数组（从 0 开始），如 [0, 1]",
                        },
                },
                required: ["lineIndex", "wordIndices"],
        },
        execute: (args) => {
                const lineIndex = Number(args.lineIndex);
                const wordIndices = asNumberArray(args.wordIndices);
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                if (!validLineIndex(lineIndex, lines))
                        return fail(`行号 ${lineIndex} 超出范围（0-${lines.length - 1}）`);
                const line = lines[lineIndex];
                if (wordIndices.length < 2) return fail("至少需要 2 个音节序号才能合并");
                const uniq = [...new Set(wordIndices)].sort((a, b) => a - b);
                for (const i of uniq) {
                        if (i < 0 || i >= line.words.length)
                                return fail(
                                        `音节序号 ${i} 超出范围（第 ${lineIndex + 1} 行共 ${line.words.length} 个音节：0-${line.words.length - 1}）`,
                                );
                }
                const mergedWord: LyricWord = structuredClone(line.words[uniq[0]]);
                mergedWord.word = uniq.map((i) => line.words[i].word).join("");
                mergedWord.startTime = Math.min(
                        ...uniq.map((i) => line.words[i].startTime),
                );
                mergedWord.endTime = Math.max(...uniq.map((i) => line.words[i].endTime));
                const rubyParts = uniq.flatMap((i) => line.words[i].ruby ?? []);
                mergedWord.ruby =
                        rubyParts.length > 0 ? structuredClone(rubyParts) : undefined;
                mergedWord.romanWord =
                        uniq
                                .map((i) => line.words[i].romanWord ?? "")
                                .filter(Boolean)
                                .join("") || undefined;
                mergedWord.obscene = uniq.some((i) => line.words[i].obscene);
                const remove = new Set(uniq.slice(1));
                const nextWords = line.words
                        .map((w, i) => (i === uniq[0] ? mergedWord : remove.has(i) ? null : w))
                        .filter((w): w is LyricWord => w !== null);
                const nextLines = lines.map((l, i) =>
                        i === lineIndex ? { ...l, words: nextWords } : l,
                );
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = `合并第 ${lineIndex + 1} 行的 ${uniq.length} 个音节为「${mergedWord.word}」`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

const deleteLines: AgentTool = {
        name: "delete_lines",
        description: "删除指定的歌词行（不可通过本工具撤销，但用户可 Ctrl+Z 撤销）。",
        parameters: {
                type: "object",
                properties: {
                        lineIndices: {
                                type: "array",
                                items: { type: "number" },
                                description: "要删除的行号数组（从 0 开始）",
                        },
                },
                required: ["lineIndices"],
        },
        execute: (args) => {
                const indices = asNumberArray(args.lineIndices);
                if (indices.length === 0) return fail("缺少行号");
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                const remove = new Set(indices);
                if (remove.size >= lines.length) return fail("不能删除全部行");
                for (const i of remove) {
                        if (!validLineIndex(i, lines))
                                return fail(`行号 ${i} 超出范围（0-${lines.length - 1}）`);
                }
                const nextLines = lines.filter((_, i) => !remove.has(i));
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = `删除 ${remove.size} 行`;
                recordAIHistory(desc);
                return ok(desc, { newLineCount: nextLines.length });
        },
};

const insertLine: AgentTool = {
        name: "insert_line",
        description: "在指定位置插入一个新的空歌词行（可带初始文本，作为一个音节）。",
        parameters: {
                type: "object",
                properties: {
                        afterIndex: {
                                type: "number",
                                description: "插入到该行之后（-1 表示插到最前面，行数则追加到最后）",
                        },
                        text: {
                                type: "string",
                                description: "可选的初始文本（整行作为一个音节）",
                        },
                },
                required: [],
        },
        execute: (args) => {
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                let afterIndex = Number(args.afterIndex ?? lines.length - 1);
                if (afterIndex < -1) afterIndex = -1;
                if (afterIndex >= lines.length) afterIndex = lines.length - 1;
                const line = newLyricLine();
                const text = String(args.text ?? "");
                if (text) {
                        const word = newLyricWord();
                        word.word = text;
                        line.words.push(word);
                }
                const insertAt = afterIndex + 1;
                const nextLines = [...lines];
                nextLines.splice(insertAt, 0, line);
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = text ? `插入歌词行「${text.slice(0, 20)}」` : "插入空歌词行";
                recordAIHistory(desc);
                return ok(desc, { newLineIndex: insertAt });
        },
};

const replaceWordText: AgentTool = {
        name: "replace_word_text",
        description: "修改某个音节（词）的文本，例如修正错别字。",
        parameters: {
                type: "object",
                properties: {
                        lineIndex: { type: "number", description: "行号（从 0 开始）" },
                        wordIndex: { type: "number", description: "音节序号（从 0 开始）" },
                        text: { type: "string", description: "新文本" },
                },
                required: ["lineIndex", "wordIndex", "text"],
        },
        execute: (args) => {
                const lineIndex = Number(args.lineIndex);
                const wordIndex = Number(args.wordIndex);
                const text = String(args.text ?? "");
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                if (!validLineIndex(lineIndex, lines))
                        return fail(`行号 ${lineIndex} 超出范围`);
                const word = lines[lineIndex].words[wordIndex];
                if (!word) return fail(`音节序号 ${wordIndex} 超出范围`);
                const old = word.word;
                const nextLines = lines.map((l, li) =>
                        li === lineIndex
                                ? {
                                                ...l,
                                                words: l.words.map((w, wi) =>
                                                        wi === wordIndex ? { ...w, word: text } : w,
                                                ),
                                        }
                                : l,
                );
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = `修改音节文本「${old}」→「${text}」`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

const setWordRuby: AgentTool = {
        name: "set_word_ruby",
        description:
                "为一个音节（词）设置假名注音。kana 是假名数组，每个元素是一个读音单元（拗音如「きゃ」算一个单元），使用平假名。时间会在音节时间范围内均匀分配。",
        parameters: {
                type: "object",
                properties: {
                        lineIndex: { type: "number", description: "行号（从 0 开始）" },
                        wordIndex: { type: "number", description: "音节序号（从 0 开始）" },
                        kana: {
                                type: "array",
                                items: { type: "string" },
                                description: '假名读音数组，如「愛して」应为 ["あい", "して"]',
                        },
                },
                required: ["lineIndex", "wordIndex", "kana"],
        },
        execute: (args) => {
                const lineIndex = Number(args.lineIndex);
                const wordIndex = Number(args.wordIndex);
                const kana = Array.isArray(args.kana)
                        ? args.kana.map(String).filter((s) => s.trim())
                        : [];
                if (kana.length === 0) return fail("kana 不能为空");
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                if (!validLineIndex(lineIndex, lines))
                        return fail(`行号 ${lineIndex} 超出范围`);
                const word = lines[lineIndex].words[wordIndex];
                if (!word) return fail(`音节序号 ${wordIndex} 超出范围`);
                const start = word.startTime;
                const end = word.endTime > start ? word.endTime : start;
                const span = end - start;
                const ruby = kana.map((k, i) => ({
                        word: k,
                        startTime: start + (span * i) / kana.length,
                        endTime: start + (span * (i + 1)) / kana.length,
                }));
                const nextLines = lines.map((l, li) =>
                        li === lineIndex
                                ? {
                                                ...l,
                                                words: l.words.map((w, wi) =>
                                                        wi === wordIndex ? { ...w, ruby } : w,
                                                ),
                                        }
                                : l,
                );
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = `为「${word.word}」标注假名 ${kana.join("")}`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

const batchSetRuby: AgentTool = {
        name: "batch_set_ruby",
        description:
                "批量设置多个音节的假名注音（比逐个调用 set_word_ruby 更高效）。rubies 是数组，每项包含行号、音节序号与假名数组。",
        parameters: {
                type: "object",
                properties: {
                        rubies: {
                                type: "array",
                                items: {
                                        type: "object",
                                        properties: {
                                                lineIndex: { type: "number" },
                                                wordIndex: { type: "number" },
                                                kana: { type: "array", items: { type: "string" } },
                                        },
                                        required: ["lineIndex", "wordIndex", "kana"],
                                },
                                description: "批量注音列表",
                        },
                },
                required: ["rubies"],
        },
        execute: (args) => {
                const rubies = Array.isArray(args.rubies) ? args.rubies : [];
                if (rubies.length === 0) return fail("rubies 不能为空");
                const lyric = getLyric();
                const lines = structuredClone(lyric.lyricLines) as LyricLine[];
                let applied = 0;
                const errors: string[] = [];
                for (const item of rubies) {
                        const li = Number(item?.lineIndex);
                        const wi = Number(item?.wordIndex);
                        const kana: string[] = Array.isArray(item?.kana)
                                ? (item.kana as unknown[]).map(String).filter((s: string) => s.trim())
                                : [];
                        if (!validLineIndex(li, lines) || !lines[li].words[wi]) {
                                errors.push(`行 ${li} 音节 ${wi} 不存在`);
                                continue;
                        }
                        if (kana.length === 0) {
                                errors.push(`行 ${li} 音节 ${wi} 假名为空`);
                                continue;
                        }
                        const word = lines[li].words[wi];
                        const start = word.startTime;
                        const end = word.endTime > start ? word.endTime : start;
                        const span = end - start;
                        word.ruby = kana.map((k: string, i: number) => ({
                                word: k,
                                startTime: start + (span * i) / kana.length,
                                endTime: start + (span * (i + 1)) / kana.length,
                        }));
                        applied++;
                }
                if (applied === 0)
                        return fail(`全部失败：${errors.slice(0, 3).join("；")}`);
                setLyric({ ...lyric, lyricLines: lines });
                const desc = `为 ${applied} 个音节标注假名`;
                recordAIHistory(desc);
                return ok(
                        desc,
                        errors.length > 0 ? { errors: errors.slice(0, 5) } : undefined,
                );
        },
};

const autoRomaji: AgentTool = {
        name: "auto_romaji",
        description:
                "自动生成罗马音：从已有假名注音（或本身就是假名的音节）转换 Hepburn 罗马音，写入逐字音译与整行音译。无法转换的（无假名的汉字）会跳过。",
        parameters: {
                type: "object",
                properties: {
                        lineIndices: {
                                type: "array",
                                items: { type: "number" },
                                description: "要处理的行号数组；不传则处理全部行",
                        },
                },
                required: [],
        },
        execute: (args) => {
                const lyric = getLyric();
                const lines = structuredClone(lyric.lyricLines) as LyricLine[];
                const target = asNumberArray(args.lineIndices);
                let converted = 0;
                let lineRomanCount = 0;
                lines.forEach((line, li) => {
                        if (target.length > 0 && !target.includes(li)) return;
                        const parts: string[] = [];
                        for (const word of line.words) {
                                const kanaSource =
                                        word.ruby && word.ruby.length > 0
                                                ? word.ruby.map((r) => r.word).join("")
                                                : wanakana.isKana(word.word)
                                                        ? word.word
                                                        : "";
                                if (kanaSource) {
                                        const roman = wanakana.toRomaji(kanaSource);
                                        if (roman) {
                                                word.romanWord = roman;
                                                converted++;
                                        }
                                }
                                if (word.romanWord) parts.push(word.romanWord);
                        }
                        if (parts.length > 0) {
                                line.romanLyric = parts.join(" ");
                                lineRomanCount++;
                        }
                });
                if (converted === 0)
                        return fail(
                                "没有可转换的音节（罗马音需要假名注音或假名文本，请先标注假名）",
                        );
                setLyric({ ...lyric, lyricLines: lines });
                const desc = `自动生成罗马音（${converted} 个音节 / ${lineRomanCount} 行）`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

const setLineRoman: AgentTool = {
        name: "set_line_roman",
        description: "设置某一行的整行音译（罗马音行文本）。",
        parameters: {
                type: "object",
                properties: {
                        lineIndex: { type: "number", description: "行号（从 0 开始）" },
                        roman: { type: "string", description: "整行音译文本" },
                },
                required: ["lineIndex", "roman"],
        },
        execute: (args) => {
                const lineIndex = Number(args.lineIndex);
                const roman = String(args.roman ?? "");
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                if (!validLineIndex(lineIndex, lines))
                        return fail(`行号 ${lineIndex} 超出范围`);
                const nextLines = lines.map((l, i) =>
                        i === lineIndex ? { ...l, romanLyric: roman } : l,
                );
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = `设置第 ${lineIndex + 1} 行音译`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

const setLineTranslation: AgentTool = {
        name: "set_line_translation",
        description: "设置某一行的翻译文本（如中文翻译）。",
        parameters: {
                type: "object",
                properties: {
                        lineIndex: { type: "number", description: "行号（从 0 开始）" },
                        translation: { type: "string", description: "翻译文本" },
                },
                required: ["lineIndex", "translation"],
        },
        execute: (args) => {
                const lineIndex = Number(args.lineIndex);
                const translation = String(args.translation ?? "");
                const lyric = getLyric();
                const lines = lyric.lyricLines;
                if (!validLineIndex(lineIndex, lines))
                        return fail(`行号 ${lineIndex} 超出范围`);
                const nextLines = lines.map((l, i) =>
                        i === lineIndex ? { ...l, translatedLyric: translation } : l,
                );
                setLyric({ ...lyric, lyricLines: nextLines });
                const desc = `设置第 ${lineIndex + 1} 行翻译`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

const setMetadata: AgentTool = {
        name: "set_metadata",
        description:
                "设置文档元数据。常用键：musicName（歌曲名称）、artists（艺术家，多人用 / 分隔会自动拆分为多条）、songwriter（词曲作者，同样支持 / 拆分）、album（专辑名）、qqMusicId（QQ 音乐 ID）、ncmMusicId、isrc。用于补全缺失的歌曲信息。",
        parameters: {
                type: "object",
                properties: {
                        key: { type: "string", description: "元数据键，如 musicName" },
                        value: { type: "string", description: "元数据值" },
                },
                required: ["key", "value"],
        },
        execute: (args) => {
                const key = String(args.key ?? "").trim();
                const value = String(args.value ?? "");
                if (!key) return fail("缺少 key");
                // artists/songwriter 的多值约定：多次添加该键值，/ 或 、分隔自动拆分
                const values =
                        key === "artists" || key === "songwriter"
                                ? value
                                        .split(/\s*[/、]\s*/)
                                        .filter(Boolean)
                                : [value];
                if (values.length === 0 || !values[0]) return fail("值不能为空");
                const lyric = getLyric();
                const existing = lyric.metadata.find((m) => m.key === key);
                let nextMetadata: TTMLMetadata[];
                if (existing) {
                        nextMetadata = lyric.metadata.map((m) =>
                                m.key === key ? { ...m, value: values } : m,
                        );
                } else {
                        nextMetadata = [...lyric.metadata, { key, value: values }];
                }
                setLyric({ ...lyric, metadata: nextMetadata });
                const desc = `设置元数据 ${key} = ${value.slice(0, 30)}`;
                recordAIHistory(desc);
                return ok(desc);
        },
};

/** 全部工具（导出给 Agent 使用） */
export const AGENT_TOOLS: AgentTool[] = [
        getLyricsInfo,
        searchWeb,
        searchQQMusic,
        importQQLyric,
        readPage,
        mergeLines,
        mergeSyllables,
        deleteLines,
        insertLine,
        replaceWordText,
        setWordRuby,
        batchSetRuby,
        autoRomaji,
        setLineRoman,
        setLineTranslation,
        setMetadata,
];

export const getAgentTool = (name: string) =>
        AGENT_TOOLS.find((tool) => tool.name === name);

/** OpenAI function calling 格式的工具定义 */
export const getToolSchemas = () =>
        AGENT_TOOLS.map((tool) => ({
                type: "function",
                function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters,
                },
        }));
