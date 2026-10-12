import type { LyricLine, LyricWord, TTMLLyric } from "$/types/ttml";

export function findMainLineIndex(
	lines: LyricLine[],
	index: number,
): number | null {
	for (let i = index - 1; i >= 0; i--) {if (!lines[i].followMainTimeline) return i;}
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
	if (main.words.length === 0) {
		const step = (main.endTime - main.startTime) / target.words.length;
		target.words.forEach((word, i) => {
			remapWordTimeline(
				word,
				main.startTime + i * step,
				main.startTime + (i + 1) * step,
			);
		});
		return;
	}
	const anchors: number[] = [
		...new Set(
			main.words.flatMap((mainWord) => [
				mainWord.startTime,
				mainWord.endTime,
			]),
		),
	];
	anchors.sort((a, b) => a - b);
	const anchorCount = anchors.length;
	const interp = (t: number): number => {
		if (t <= 0) return anchors[0];
		if (t >= anchorCount - 1) return anchors[anchorCount - 1];
		const i = Math.floor(t);
		const frac = t - i;
		return anchors[i] + (anchors[i + 1] - anchors[i]) * frac;
	};
	const span = anchorCount - 1;
	target.words.forEach((word, i) => {
		remapWordTimeline(
			word,
			interp((i / target.words.length) * span),
			interp(((i + 1) / target.words.length) * span),
		);
	});
}

export function reconcileFollowMainTimeline(state: TTMLLyric) {
	const lines = state.lyricLines;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.followMainTimeline) continue;
		if (!line.isBG && !line.isDuet) continue;
		const mainIndex = findMainLineIndex(lines, i);
		if (mainIndex === null) {
			line.followMainTimeline = false;
			continue;
		}
		const main = lines[mainIndex];
		if (!main) {
			line.followMainTimeline = false;
			continue;
		}
		if (line.words.length !== main.words.length) {
			line.followMainTimeline = false;
			continue;
		}
		copyTimelineFromMain(line, main);
	}
}