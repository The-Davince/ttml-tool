import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

/**
 * 消息中心状态
 *
 * 消息记录以同步单元 ID 为键（普通单词为 word.id，假名为
 * buildRubySelectionId 的结果），只保存首次检测到的时间。
 * 音节当前是否仍存在倒流由 backflowUnitsAtom 实时派生，
 * 因此倒流修复后消息会自动置灰，再次出现时自动恢复。
 */

export interface LyricMessageRecord {
	/** 首次检测到该问题的时间戳 (ms) */
	firstDetectedAt: number;
}

/**
 * 消息记录表：unitId -> 记录
 *
 * 新文档载入时会被清空（见 newLyricLinesAtom），
 * 音节被删除时对应记录会被 MessageCenter 清理
 */
export const lyricMessagesAtom = atom<Record<string, LyricMessageRecord>>({});

/**
 * 消息面板的排序方式
 *
 * - time：按检测到问题的时间先后排序
 * - position：按行号和音节位置从小到大排序
 */
export type MessagesSortMode = "time" | "position";

export const messagesSortModeAtom = atomWithStorage<MessagesSortMode>(
	"messagesSortMode",
	"time",
);
