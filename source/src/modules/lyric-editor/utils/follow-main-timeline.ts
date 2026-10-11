import type { LyricLine, LyricWord, TTMLLyric } from "$/types/ttml";

export function findMainLineIndex(
	lines: LyricLine[],
	index: number,
): number | null {
	for (let i = index - 1; i >= 0; i--) {if (!lines[i].isBG && !lines[i].isDuet) return i;}
	return null;
}

function remapWordTimeline(word: LyricWord, newStart: number, newEnd: number) {
	const oldStart = word.startTime;
	const oldEnd = word.endTime;
	word.startTime = newStart;
	word.endTime = newEnd;
	if (!word.ruby || word.ruby.length === 0) return;
	const oldSpan = oldEnd - oldStart;
	if (oldSpan > 0) {
		for (const kana of word.ruby) {
			kana.startTime =
				newStart + ((kana.startTime - oldStart) / oldSpan) * (newEnd - newStart);
			kana.endTime =
				newStart + ((kana.endTime - oldStart) / oldSpan) * (newEnd - newStart);
		}
	} else {
		const step = (newEnd - newStart) / word.ruby.length;
		word.ruby.forEach((kana, i) => {
			kana.startTime = newStart + i * step;
			kana.endTime = newStart + (i + 1) * step;
		});
	}
}

export function copyTimelineFromMain(target: LyricLine, main: LyricLine) {
	target.startTime = main.startTime;
	target.endTime = main.endTime;
	delete target.endTimeLink;
	if (target.words.length === 0) return;
	if (target.words.length === main.words.length) {
		target.words.forEach((word, i) => {
			remapWordTimeline(word, main.words[i].startTime, main.words[i].endTime);
		});
		return;
	}
	const firstStart = target.words[0].startTime;
	const lastEnd = target.words[target.words.length - 1].endTime;
	const oldSpan = lastEnd - firstStart;
	const mainSpan = main.endTime - main.startTime;
	if (oldSpan > 0) {
		const scale = mainSpan / oldSpan;
		for (const word of target.words) {
			remapWordTimeline(
				word,
				main.startTime + (word.startTime - firstStart) * scale,
				main.startTime + (word.endTime - firstStart) * scale,
			);
		}
	} else {
		const step = mainSpan / target.words.length;
		target.words.forEach((word, i) => {
			remapWordTimeline(
				word,
				main.startTime + i * step,
				main.startTime + (i + 1) * step,
			);
		});
	}
}

export function reconcileFollowMainTimeline(state: TTMLLyric) {
	const lines = state.lyricLines;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.followMainTimeline) continue;
		if (!line.isBG && !line.isDuet) continue;
		const mainIndex = findMainLineIndex(lines, i);
		if (mainIndex === null) continue;
		const main = lines[mainIndex];
		if (!main) continue;
		copyTimelineFromMain(line, main);
	}
}