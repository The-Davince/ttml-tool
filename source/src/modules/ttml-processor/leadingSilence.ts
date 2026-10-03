/**
 * leadingSilence 音译时间轴自动对齐
 *
 * 背景：Apple Music TTML 的 `<iTunesMetadata leadingSilence="…">` 表示音频开头的
 * 前置静音时长。不少转换 / 裁剪工具在处理时只对正文 body 的时间轴扣除了这段静音，
 * 却漏掉了 head 里 `<transliterations>` 的音译时间（或反之），于是同一份文件里出现
 * 两套相差正好 leadingSilence 的时间轴。AMLL 解析器按时间把音译与逐字配对
 * （±2ms 快速通道 / IoU≥0.1），整体错位后会导致逐字音译为空或错位配对。
 *
 * 本模块在解析前检测这种「音译时间轴相对正文的统一偏移」，并把音译侧时间整体平移，
 * 使其与正文逐字对齐。算法与判定阈值对齐诊断修复工具（TTML_ENGINE）：
 * 复用其时间解析 / 格式化、行引用匹配（itunes:key / xml:id）与 fixTranslit 平移逻辑。
 */

//#region 类型
export interface LeadingSilenceFixResult {
	/** 修复后的 TTML 文本；未修复时等于原文 */
	text: string;
	/** 是否实际执行了平移修复 */
	applied: boolean;
	/**
	 * 检测到的音译时间轴相对正文的统一偏移（ms）
	 *
	 * 正数表示音译整体偏晚，负数表示偏早；无有效样本时为 null
	 */
	offsetMs: number | null;
	/** leadingSilence 属性值（ms），不存在时为 null */
	leadingSilenceMs: number | null;
	/** 偏移量是否与 leadingSilence 一致（1ms 容差内） */
	matchesLeadingSilence: boolean;
	/** 偏移一致性比例（0~1），即众数偏移占总时间戳的比例 */
	uniformity: number;
	/** 被平移的音译 span 数量 */
	shiftedSpanCount: number;
}
//#endregion

//#region 常量
const NS_ITUNES = "http://music.apple.com/lyric-ttml-internal";
const NS_XML = "http://www.w3.org/XML/1998/namespace";

/** 触发自动修复所需的最低偏移一致性比例 */
const MIN_UNIFORMITY = 0.8;
//#endregion

//#region 时间解析 / 格式化
/** 将 TTML 时间字符串解析为毫秒；无法解析返回 null */
export function parseTimeMs(str: string | null | undefined): number | null {
	if (str == null) return null;
	const s = String(str).trim();
	if (s === "") return null;
	const unitMatch = s.match(/^(-?[\d.]+)(ms|s|f|t)$/);
	if (unitMatch) {
		const v = Number.parseFloat(unitMatch[1]);
		if (Number.isNaN(v)) return null;
		if (unitMatch[2] === "ms") return Math.round(v);
		if (unitMatch[2] === "s") return Math.round(v * 1000);
		return null; // 帧滴 (f/t) 不支持
	}
	const parts = s.split(":");
	if (parts.length < 1 || parts.length > 3) return null;
	let secs = 0;
	for (const part of parts) {
		const p = Number.parseFloat(part);
		if (Number.isNaN(p)) return null;
		secs = secs * 60 + p;
	}
	return Math.round(secs * 1000);
}

/** 将毫秒格式化为 TTML 时间字符串（S.mmm / M:S.mmm / H:M:S.mmm） */
export function formatTimeMs(ms: number): string {
	const value = Math.max(0, Math.round(ms));
	const totalSec = value / 1000;
	if (value < 60000) return totalSec.toFixed(3);
	if (value < 3600000) {
		const m = Math.floor(totalSec / 60);
		const s = totalSec - m * 60;
		return `${m}:${s.toFixed(3).padStart(6, "0")}`;
	}
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec - h * 3600) / 60);
	const s = totalSec - h * 3600 - m * 60;
	return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}
//#endregion

//#region XML 辅助（命名空间无关）
function getAttr(
	el: Element,
	nsUri: string,
	prefixedName: string,
	local: string,
): string | null {
	try {
		const v = el.getAttributeNS(nsUri, local);
		if (v != null && v !== "") return v;
	} catch {
		/* ignore */
	}
	const v2 = el.getAttribute(prefixedName);
	return v2 == null || v2 === "" ? null : v2;
}

function childElements(el: Element, local: string): Element[] {
	const out: Element[] = [];
	for (const c of Array.from(el.children)) {
		if (c.localName === local) out.push(c);
	}
	return out;
}

function descendants(root: Element, local: string): Element[] {
	const out: Element[] = [];
	const stack: Element[] = [root];
	while (stack.length) {
		const cur = stack.pop() as Element;
		for (const c of Array.from(cur.children)) {
			if (c.localName === local) out.push(c);
			stack.push(c);
		}
	}
	return out;
}
//#endregion

//#region 结构解析
interface TimedSpan {
	begin: number | null;
	end: number | null;
}

interface BodyLine {
	id: string | null;
	words: TimedSpan[];
}

interface TranslitEntry {
	texts: Map<string, TimedSpan[]>;
}

interface ParsedStructure {
	lines: BodyLine[];
	translits: TranslitEntry[];
	leadingSilenceMs: number | null;
}

/**
 * 解析 TTML，提取正文逐字行、音译行与 leadingSilence
 * @returns 解析结构；无法解析（非 XML / 缺 body）时返回 null
 */
function parseStructure(rawText: string): ParsedStructure | null {
	if (typeof DOMParser === "undefined") return null;

	let doc: Document;
	try {
		doc = new DOMParser().parseFromString(rawText, "text/xml");
	} catch {
		return null;
	}
	if (!doc || !doc.documentElement) return null;
	if (
		doc.getElementsByTagName("parsererror").length > 0 ||
		doc.documentElement.localName === "parsererror"
	) {
		return null;
	}

	const root = doc.documentElement;
	const bodyList = descendants(root, "body");
	if (!bodyList.length) return null;

	// 正文逐字行
	// 注意：Apple TTML 的 <p> 常嵌套在 <div itunes:songPart> 内，必须递归查找
	const lines: BodyLine[] = [];
	for (const p of descendants(bodyList[0], "p")) {
		const id =
			getAttr(p, NS_ITUNES, "itunes:key", "key") ??
			getAttr(p, NS_XML, "xml:id", "id");
		const words: TimedSpan[] = childElements(p, "span").map((sp) => ({
			begin: parseTimeMs(sp.getAttribute("begin")),
			end: parseTimeMs(sp.getAttribute("end")),
		}));
		lines.push({ id: id ?? null, words });
	}

	// leadingSilence
	const imEls = descendants(root, "iTunesMetadata");
	const leadingSilenceMs = imEls.length
		? parseTimeMs(imEls[0].getAttribute("leadingSilence"))
		: null;

	// 音译
	const translits: TranslitEntry[] = [];
	for (const trEl of descendants(root, "transliteration")) {
		const texts = new Map<string, TimedSpan[]>();
		for (const textEl of childElements(trEl, "text")) {
			const forId = textEl.getAttribute("for");
			if (!forId) continue;
			const spans: TimedSpan[] = childElements(textEl, "span").map(
				(rs) => ({
					begin: parseTimeMs(rs.getAttribute("begin")),
					end: parseTimeMs(rs.getAttribute("end")),
				}),
			);
			if (spans.length && !texts.has(forId)) texts.set(forId, spans);
		}
		translits.push({ texts });
	}

	return { lines, translits, leadingSilenceMs };
}
//#endregion

//#region 偏移检测
interface OffsetInfo {
	mode: number | null;
	modeCount: number;
	totalDiffs: number;
	uniformity: number;
}

/**
 * 检测音译时间轴相对正文的统一偏移
 *
 * 仅统计逐字数与音译 span 数一致、且时间可解析的行，
 * 取「音译时间 - 正文时间」差值的众数作为统一偏移
 */
function detectOffset(structure: ParsedStructure): OffsetInfo {
	const diffs: number[] = [];
	for (const tr of structure.translits) {
		for (const line of structure.lines) {
			if (!line.id) continue;
			const spans = tr.texts.get(line.id);
			if (!spans || !spans.length || !line.words.length) continue;
			if (spans.length !== line.words.length) continue;
			const bad =
				line.words.some((w) => w.begin == null || w.end == null) ||
				spans.some((s) => s.begin == null || s.end == null);
			if (bad) continue;
			for (let i = 0; i < spans.length; i++) {
				diffs.push((spans[i].begin as number) - (line.words[i].begin as number));
				diffs.push((spans[i].end as number) - (line.words[i].end as number));
			}
		}
	}

	if (!diffs.length) {
		return { mode: null, modeCount: 0, totalDiffs: 0, uniformity: 0 };
	}

	const counter = new Map<number, number>();
	for (const d of diffs) counter.set(d, (counter.get(d) ?? 0) + 1);

	// 绝对值最小优先，保证在无偏移时倾向选 0
	const keys = Array.from(counter.keys()).sort(
		(a, b) => Math.abs(a) - Math.abs(b) || a - b,
	);
	let mode = 0;
	let modeCount = 0;
	for (const k of keys) {
		const c = counter.get(k) as number;
		if (c > modeCount) {
			mode = k;
			modeCount = c;
		}
	}

	return {
		mode,
		modeCount,
		totalDiffs: diffs.length,
		uniformity: modeCount / diffs.length,
	};
}
//#endregion

//#region 音译平移修复
/**
 * 将 `<transliterations>` 区域内所有音译 span 的 begin/end 统一平移 shiftMs
 *
 * 只改写音译侧时间戳，正文与其余内容保持原样；平移后为负的时间钳制为 0
 * @returns 平移后的完整文本；区域缺失或无可修复 span 时返回 null
 */
export function shiftTransliteration(
	rawText: string,
	shiftMs: number,
): { text: string; touched: number } | null {
	const open = rawText.search(/<transliterations(?=[\s/>])/);
	if (open === -1) return null;
	const close = rawText.indexOf("</transliterations>", open);
	if (close === -1) return null;

	const zone = rawText.slice(open, close);
	if (/^<transliterations\s*\/\s*>/.test(zone)) return null;

	let touched = 0;
	const fixedZone = zone.replace(
		/<span\s+begin="([^"]*)"\s+end="([^"]*)"/g,
		(match, b: string, e: string) => {
			const bms = parseTimeMs(b);
			const ems = parseTimeMs(e);
			if (bms == null || ems == null) return match;
			const nb = Math.max(0, bms + shiftMs);
			const ne = Math.max(0, ems + shiftMs);
			touched++;
			return `<span begin="${formatTimeMs(nb)}" end="${formatTimeMs(ne)}"`;
		},
	);

	if (!touched) return null;
	return {
		text: rawText.slice(0, open) + fixedZone + rawText.slice(close),
		touched,
	};
}
//#endregion

//#region 对外主入口
/**
 * 检测并自动修复「音译时间轴相对正文因 leadingSilence 产生的统一偏移」
 *
 * 当且仅当满足以下条件时才执行平移：
 * - 存在统一偏移（众数偏移 ≠ 0）
 * - 偏移一致性 ≥ {@link MIN_UNIFORMITY}
 * - 且偏移量与 leadingSilence 一致，或文件未声明 leadingSilence（保守兜底）
 *
 * 不满足条件时原样返回，绝不改动内容
 * @param ttmlContent 原始 TTML 文本
 */
export function autoAlignLeadingSilence(
	ttmlContent: string,
): LeadingSilenceFixResult {
	const noop: LeadingSilenceFixResult = {
		text: ttmlContent,
		applied: false,
		offsetMs: null,
		leadingSilenceMs: null,
		matchesLeadingSilence: false,
		uniformity: 0,
		shiftedSpanCount: 0,
	};

	const structure = parseStructure(ttmlContent);
	if (!structure) return noop;

	const offset = detectOffset(structure);
	const leadingSilenceMs = structure.leadingSilenceMs;
	const matchesLeadingSilence =
		offset.mode != null &&
		leadingSilenceMs != null &&
		Math.abs(offset.mode - leadingSilenceMs) < 1;

	const base: LeadingSilenceFixResult = {
		...noop,
		offsetMs: offset.mode,
		leadingSilenceMs,
		matchesLeadingSilence,
		uniformity: offset.uniformity,
	};

	if (
		offset.mode == null ||
		offset.mode === 0 ||
		offset.uniformity < MIN_UNIFORMITY ||
		// 有 leadingSilence 时要求偏移与之吻合；无 leadingSilence 时接受高一致性统一偏移
		(leadingSilenceMs != null && !matchesLeadingSilence)
	) {
		return base;
	}

	const shifted = shiftTransliteration(ttmlContent, -offset.mode);
	if (!shifted) return base;

	return {
		text: shifted.text,
		applied: true,
		offsetMs: offset.mode,
		leadingSilenceMs,
		matchesLeadingSilence,
		uniformity: offset.uniformity,
		shiftedSpanCount: shifted.touched,
	};
}
//#endregion
