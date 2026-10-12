import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect, useRef } from "react";
import {
	backflowUnitsAtom,
	lineUnitIdsAtom,
} from "$/modules/lyric-editor/utils/backflow";
import { lyricMessagesAtom } from "$/states/messages";
import { openTabAtom } from "$/states/sidebar";

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
			for (const [id, record] of Object.entries(prev)) {
				if (unitIds.has(id)) {
					next[id] = record;
				} else {
					changed = true;
				}
			}
			// 倒流创建新消息
			const now = Date.now();
			for (const id of activeIds) {
				if (!next[id]) {
					next[id] = { firstDetectedAt: now };
					changed = true;
				}
			}
			return changed ? next : prev;
		});
		// 倒流消息打开面板
		if (prevActiveCountRef.current === 0 && activeIds.length > 0) {
			store.set(openTabAtom, "messages");
		}
		prevActiveCountRef.current = activeIds.length;
	}, [backflowUnits, unitIds, setMessages, store]);

	return null;
};

export default MessageCenter;
