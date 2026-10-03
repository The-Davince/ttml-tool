import { atomWithStorage } from "jotai/utils";

/**
 * 主题强调色选择
 *
 * "default" 表示沿用原版配色（浅色 green / 深色 jade），
 * 其余取值为 Radix Themes 支持的 accentColor 名称
 */
export type ThemeAccentChoice =
	| "default"
	| "gray"
	| "gold"
	| "bronze"
	| "brown"
	| "yellow"
	| "amber"
	| "orange"
	| "tomato"
	| "red"
	| "ruby"
	| "crimson"
	| "pink"
	| "plum"
	| "purple"
	| "violet"
	| "iris"
	| "indigo"
	| "blue"
	| "cyan"
	| "teal"
	| "jade"
	| "green"
	| "grass"
	| "lime"
	| "mint"
	| "sky";

export const themeAccentAtom = atomWithStorage<ThemeAccentChoice>(
	"themeAccent",
	"default",
);

/** 设置面板中展示的可选强调色（顺序即展示顺序） */
export const THEME_ACCENT_CHOICES: ThemeAccentChoice[] = [
	"default",
	"iris",
	"violet",
	"purple",
	"indigo",
	"blue",
	"sky",
	"cyan",
	"teal",
	"jade",
	"green",
	"grass",
	"lime",
	"mint",
	"yellow",
	"amber",
	"orange",
	"tomato",
	"red",
	"ruby",
	"crimson",
	"pink",
	"plum",
	"bronze",
	"gold",
	"gray",
];
