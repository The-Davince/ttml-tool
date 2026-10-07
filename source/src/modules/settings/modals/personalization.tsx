import {
	Color24Regular,
	CursorClick24Regular,
	DarkTheme24Regular,
	PanelRight24Regular,
	TextFontSize24Regular,
} from "@fluentui/react-icons";
import { Flex, SegmentedControl, Slider, Switch, Text } from "@radix-ui/themes";
import { AnimatePresence, motion } from "framer-motion";
import { useAtom, useSetAtom } from "jotai";
import { useTranslation } from "react-i18next";
import { settingsDialogAtom } from "$/states/dialogs.ts";
import { DarkMode, darkModeAtom } from "$/states/main";
import { THEME_ACCENT_CHOICES, themeAccentAtom } from "$/modules/settings/states/theme";
import {
	lineClickTogglesToolWindowAtom,
	TOOL_WINDOW_DEFAULT_FONT_SIZE,
	TOOL_WINDOW_MAX_FONT_SIZE,
	TOOL_WINDOW_MIN_FONT_SIZE,
	toolWindowFontSizeAtom,
	toolWindowOpenAtom,
} from "$/modules/settings/states/tool-window";
import styles from "./SettingsDialog.module.css";
import {
	SettingsCustomBackgroundCard,
	SettingsCustomBackgroundSettings,
} from "./customBackground";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import {
	SettingsSpectrogramCustomPalettePage,
	SettingsSpectrogramPalettePage,
} from "./spectrogram";

const contentTransition = {
	duration: 0.25,
	ease: [0.4, 0, 0.2, 1],
} as const;

const contentVariants = {
	initial: { opacity: 0, y: 12 },
	animate: { opacity: 1, y: 0 },
} as const;

export const SettingsPersonalizationTab = ({
	subpage,
	onSubpageChange,
}: {
	subpage: "customBackground" | "customPalette" | null;
	onSubpageChange: (
		subpage: "customBackground" | "customPalette" | null,
	) => void;
}) => {
	const [darkMode, setDarkMode] = useAtom(darkModeAtom);
	const [themeAccent, setThemeAccent] = useAtom(themeAccentAtom);
	const [toolWindowOpen, setToolWindowOpen] = useAtom(toolWindowOpenAtom);
	const [lineClickToggles, setLineClickToggles] = useAtom(
		lineClickTogglesToolWindowAtom,
	);
	const [toolWindowFontSize, setToolWindowFontSize] = useAtom(
		toolWindowFontSizeAtom,
	);
	const setSettingsOpen = useSetAtom(settingsDialogAtom);
	const { t } = useTranslation();
	const spectrogramTitle = t("settingsDialog.tab.spectrogram", "频谱图");

	const subpageContent =
		subpage === "customBackground" ? (
			<SettingsCustomBackgroundSettings />
		) : subpage === "customPalette" ? (
			<SettingsSpectrogramCustomPalettePage />
		) : null;

	return (
		<AnimatePresence initial={false}>
			{subpage ? (
				<motion.div
					key={subpage}
					variants={contentVariants}
					initial="initial"
					animate="animate"
					exit="exit"
					transition={contentTransition}
				>
					{subpageContent}
				</motion.div>
			) : (
				<motion.div
					key="personalization-main"
					variants={contentVariants}
					initial="initial"
					animate="animate"
					transition={contentTransition}
				>
					<Flex direction="column" gap="4">
						<SettingsGroup>
							<SettingsRow
								icon={<DarkTheme24Regular />}
								title={t("settings.personalization.theme", "外观主题")}
								description={t(
									"settings.personalization.themeDesc",
									"选择界面使用浅色、深色，或跟随系统设置。",
								)}
								action={
									<SegmentedControl.Root
										value={darkMode}
										onValueChange={(value) => setDarkMode(value as DarkMode)}
									>
										<SegmentedControl.Item value={DarkMode.Light}>
											{t("settings.personalization.themeLight", "浅色")}
										</SegmentedControl.Item>
										<SegmentedControl.Item value={DarkMode.Dark}>
											{t("settings.personalization.themeDark", "深色")}
										</SegmentedControl.Item>
										<SegmentedControl.Item value={DarkMode.Auto}>
											{t("settings.personalization.themeAuto", "自动")}
										</SegmentedControl.Item>
									</SegmentedControl.Root>
								}
							/>

							<SettingsRow
								icon={<Color24Regular />}
								title={t("settings.personalization.accentColor", "主题色")}
								description={t(
									"settings.personalization.accentColorDesc",
									"选择界面元素使用的强调颜色。",
								)}
							>
								<div className={styles.accentSwatchGrid}>
									{THEME_ACCENT_CHOICES.map((choice) => (
										<button
											key={choice}
											type="button"
											className={styles.paletteButton}
											data-active={themeAccent === choice || undefined}
											title={
												choice === "default"
													? t("settings.personalization.accentDefault", "默认")
													: choice
												}
												aria-label={
													choice === "default"
														? t("settings.personalization.accentDefault", "默认")
														: choice
													}
												onClick={() => setThemeAccent(choice)}
											>
												<span
													className={styles.palettePreview}
													style={
														choice === "default"
															? {
																	background:
																		"linear-gradient(135deg, var(--green-9), var(--jade-9))",
																	}
																	: { background: `var(--${choice}-9)` }
															}
													/>
											</button>
									))}
								</div>
							</SettingsRow>

							<SettingsCustomBackgroundCard
								onOpen={() => onSubpageChange("customBackground")}
							/>
						</SettingsGroup>

						<SettingsGroup title={t("settings.toolWindow.title", "工具窗口")}>
							<SettingsRow
								icon={<PanelRight24Regular />}
								title={t("settings.toolWindow.enable", "启用工具窗口")}
								description={t(
									"settings.toolWindow.desc",
									"在界面右侧打开带标签页的工具窗口，可在其中添加预览等标签页。",
								)}
								action={
									<Switch
										checked={toolWindowOpen}
										onCheckedChange={(checked) => {
											setToolWindowOpen(checked);
											if (checked) {
												setSettingsOpen(false);
											}
										}}
									/>
								}
							/>

							<SettingsRow
								icon={<CursorClick24Regular />}
								title={t(
									"settings.toolWindow.lineClickToggle",
									"点击歌词行切换窗口",
								)}
								description={t(
									"settings.toolWindow.lineClickToggleDesc",
									"在编辑界面点击歌词行时显示右侧工具窗口，再次点击同一行将其隐藏。",
								)}
								action={
									<Switch
										checked={lineClickToggles}
										onCheckedChange={(checked) =>
											setLineClickToggles(checked)
										}
									/>
								}
							/>

							<SettingsRow
								icon={<TextFontSize24Regular />}
								title={t(
									"settings.toolWindow.fontSize",
									"工具窗口歌词预览字号",
								)}
								description={t(
									"settings.toolWindow.fontSizeDesc",
									"调整工具窗口中歌词预览的字体大小，开启自动后跟随页面尺寸缩放。",
								)}
								action={
									<Switch
										checked={toolWindowFontSize === 0}
										aria-label={t(
											"settings.toolWindow.fontSizeAuto",
											"自动字号",
										)}
										onCheckedChange={(checked) =>
											setToolWindowFontSize(
													checked ? 0 : TOOL_WINDOW_DEFAULT_FONT_SIZE,
											)
										}
									/>
								}
							>
								{toolWindowFontSize !== 0 && (
									<Flex
										direction="column"
										gap="2"
										align="start"
										style={{ marginTop: 4, width: "100%" }}
									>
										<Text size="1" color="gray" wrap="nowrap">
											{toolWindowFontSize}px
										</Text>
										<Slider
											min={TOOL_WINDOW_MIN_FONT_SIZE}
											max={TOOL_WINDOW_MAX_FONT_SIZE}
											value={[toolWindowFontSize]}
											step={1}
											onValueChange={(v) => setToolWindowFontSize(v[0])}
											style={{ width: "100%" }}
										/>
									</Flex>
								)}
							</SettingsRow>
						</SettingsGroup>

						<SettingsGroup title={spectrogramTitle}>
							<SettingsSpectrogramPalettePage
								onOpenCustomPalette={() => onSubpageChange("customPalette")}
							/>
						</SettingsGroup>
					</Flex>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
