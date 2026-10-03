import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef } from "react";
import {
	backflowUnitsAtom,
	lineUnitIdsAtom,
} from "$/modules/lyric-editor/utils/backflow";
import { lyricMessagesAtom } from "$/states/messages";
import { openTabAtom } from "$/states/sidebar";

/**
 * 消息中心
 *
 * 常驻挂载的空渲染组件，负责：
 * - 持续检测音节时间倒流，为新发现的问题创建消息记录（记录首次检测时间）
 * - 清理音节已被删除的过期消息记录
 * - 当一份文档首次出现倒流问题时自动打开侧边栏“消息”视图
 */
export const MessageCenter = () => {
	const store = useStore();
	const backflowUnits = useAtomValue(backflowUnitsAtom);
	const unitIds = useAtomValue(lineUnitIdsAtom);
	const setMessages = useSetAtom(lyricMessagesAtom);
	const prevActiveCountRef = useRef(0);

	useEffect(() => {
		const activeIds = Object.keys(backflowUnits);
		setMessages((prev) => {
			let changed = false;
			const next: Record<string, { firstDetectedAt: number }> = {};
			// 仅保留文档中仍然存在的音节的消息记录
			for (const [id, record] of Object.entries(prev)) {
				if (unitIds.has(id)) {
					next[id] = record;
				} else {
					changed = true;
				}
			}
			// 为新检测到的倒流创建消息记录
			const now = Date.now();
			for (const id of activeIds) {
				if (!next[id]) {
					next[id] = { firstDetectedAt: now };
					changed = true;
				}
			}
			return changed ? next : prev;
		});
		// 当从“无任何倒流”变为“存在倒流”时自动打开消息视图，
		// 覆盖导入后即出现倒流、以及编辑过程中首次制造倒流的情况
		if (prevActiveCountRef.current === 0 && activeIds.length > 0) {
			store.set(openTabAtom, "messages");
		}
		prevActiveCountRef.current = activeIds.length;
	}, [backflowUnits, unitIds, setMessages, store]);

	return null;
};

export default MessageCenter;
