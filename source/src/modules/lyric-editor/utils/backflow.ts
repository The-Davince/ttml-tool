import { atom } from "jotai";
import { lyricLinesAtom } from "$/states/main.ts";
import type { LyricLine } from "$/types/ttml";
import { buildRubySelectionId } from "./lyric-states.ts";

/**
 * 音节时间倒流检测工具
 *
 * “倒流”包括两类情况：
 * 1. 音节之间的重叠：某个音节（单词或假名）的开始时间早于同一行内
 *    前一个音节的结束时间，例如：
 *      第 13 行第 6 个音节 'sunlight' 的开始时间 (49827) 出现倒流
 *      (早于前一个音节的结束时间 49832)
 * 2. 音节自身倒挂：某个音节自己的结束时间早于它的开始时间
 *    （时长为负），例如：
 *      第 3 行第 2 个音节的开始时间 (03:32.115) 晚于结束时间 (03:31.742)
 *
 * 检测以“同步单元”为粒度：与打轴模式显示的单元一致，
 * 即非空白单词本身，或带假名单词中的每一个假名。
 * 空白单词（纯空格等）不参与检测，也不会作为比较基准。
 */

export interface BackflowUnitInfo {
	/** 同步单元 ID：普通单词为 word.id，假名为 buildRubySelectionId 的结果 */
	unitId: string;
	/** 所属行的 ID */
	lineId: string;
	/** 单词在行内的下标 */
	wordIndex: number;
	/** 假名在 ruby 数组中的下标（普通单词为 undefined） */
	rubyIndex?: number;
	/** 倒流类型：prev=开始时间早于前一个音节的结束时间；self=结束时间早于自身开始时间 */
	type: "prev" | "self";
	/** 发生倒流单元的开始时间 */
	startTime: number;
	/** 前一个音节的结束时间（type 为 prev 时存在） */
	prevEndTime?: number;
	/** 自身结束时间（type 为 self 时存在，早于 startTime） */
	endTime?: number;
}

interface LineUnit {
	unitId: string;
	wordIndex: number;
	rubyIndex?: number;
	startTime: number;
	endTime: number;
}

/**
 * 获取一行内所有参与时序排列的同步单元
 *
 * 跳过空白单词与空白假名，与打轴模式的可同步单元保持一致
 */
function getLineUnits(line: LyricLine): LineUnit[] {
	const units: LineUnit[] = [];
	for (let wi = 0; wi < line.words.length; wi++) {
		const word = line.words[wi];
		if (word.word.trim().length === 0) continue;
		const hasKana = word.ruby?.some((r) => r.word.trim().length > 0);
		if (word.ruby && hasKana) {
			for (let ri = 0; ri < word.ruby.length; ri++) {
				const kana = word.ruby[ri];
				if (kana.word.trim().length === 0) continue;
				units.push({
					unitId: buildRubySelectionId(word.id, ri),
					wordIndex: wi,
					rubyIndex: ri,
					startTime: kana.startTime,
					endTime: kana.endTime,
				});
			}
		} else {
			units.push({
				unitId: word.id,
				wordIndex: wi,
				startTime: word.startTime,
				endTime: word.endTime,
			});
		}
	}
	return units;
}

/**
 * 检测一行内所有出现倒流的同步单元
 *
 * 同一单元同时存在两类倒流时优先报告自身倒挂（self）；
 * 修复自身倒挂后若仍与前一音节重叠，会自动转为 prev 类型继续提示。
 *
 * @returns unitId 到倒流信息的映射（仅为出现倒流的单元）
 */
export function detectLineBackflows(
	line: LyricLine,
): Record<string, BackflowUnitInfo> {
	const result: Record<string, BackflowUnitInfo> = {};
	const units = getLineUnits(line);
	for (let i = 0; i < units.length; i++) {
		const cur = units[i];
		// 音节自身倒挂：结束时间早于开始时间（时长为负）
		if (cur.endTime < cur.startTime) {
			result[cur.unitId] = {
				unitId: cur.unitId,
				lineId: line.id,
				wordIndex: cur.wordIndex,
				rubyIndex: cur.rubyIndex,
				type: "self",
				startTime: cur.startTime,
				endTime: cur.endTime,
			};
			continue;
		}
		if (i === 0) continue;
		const prev = units[i - 1];
		// 行内重叠：开始时间早于前一个音节的结束时间
		if (cur.startTime < prev.endTime) {
			result[cur.unitId] = {
				unitId: cur.unitId,
				lineId: line.id,
				wordIndex: cur.wordIndex,
				rubyIndex: cur.rubyIndex,
				type: "prev",
				startTime: cur.startTime,
				prevEndTime: prev.endTime,
			};
		}
	}
	return result;
}

/**
 * 判断指定下标的单词（本身或其任意假名）是否存在倒流
 *
 * 用于编辑界面将存在倒流的音节标红
 */
export function isWordBackflowing(line: LyricLine, wordIndex: number): boolean {
	const backflows = detectLineBackflows(line);
	for (const info of Object.values(backflows)) {
		if (info.wordIndex === wordIndex) return true;
	}
	return false;
}

/**
 * 全局派生 Atom：当前文档中所有出现倒流的同步单元
 */
export const backflowUnitsAtom = atom((get) => {
	const { lyricLines } = get(lyricLinesAtom);
	const result: Record<string, BackflowUnitInfo> = {};
	for (const line of lyricLines) {
		const backflows = detectLineBackflows(line);
		for (const [id, info] of Object.entries(backflows)) {
			result[id] = info;
		}
	}
	return result;
});

/**
 * 全局派生 Atom：当前文档中所有同步单元的 ID 集合
 *
 * 用于清理已不存在的音节对应的消息记录
 */
export const lineUnitIdsAtom = atom((get) => {
	const { lyricLines } = get(lyricLinesAtom);
	const ids = new Set<string>();
	for (const line of lyricLines) {
		for (const unit of getLineUnits(line)) {
			ids.add(unit.unitId);
		}
	}
	return ids;
});
