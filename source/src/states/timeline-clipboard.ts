import { atomWithStorage } from "jotai/utils";
import type { TimelineClipboard } from "$/modules/lyric-editor/utils/timeline-clipboard";

export const timelineClipboardAtom =
	atomWithStorage<TimelineClipboard | null>("amll.timelineClipboard", null);
