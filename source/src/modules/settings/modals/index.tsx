import {
	Info24Regular,
	Keyboard24Regular,
	PaintBrush24Regular,
	Settings24Regular,
} from "@fluentui/react-icons";
import { Box, Dialog, Heading, Text } from "@radix-ui/themes";
import { AnimatePresence, motion } from "framer-motion";
import { useAtom } from "jotai";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { settingsDialogAtom, settingsTabAtom } from "$/states/dialogs.ts";
import { useSmoothWheelScroll } from "$/utils/smoothWheelScroll.ts";
import { SettingsAboutTab } from "./about";
import { SettingsCommonTab } from "./common";
import { SettingsKeyBindingsDialog } from "./keybindings";
import { SettingsPersonalizationTab } from "./personalization";
import styles from "./SettingsDialog.module.css";

type SettingsSubpage = "customBackground" | "customPalette";

const contentTransition = {
	duration: 0.25,
	ease: [0.4, 0, 0.2, 1],
} as const;

const contentVariants = {
	initial: { opacity: 0, y: 12 },
	animate: { opacity: 1, y: 0 },
} as const;

export const SettingsDialog = memo(() => {
	const [settingsDialogOpen, setSettingsDialogOpen] =
		useAtom(settingsDialogAtom);
	const [activeTab, setActiveTab] = useAtom(settingsTabAtom);
	const [activeSubpage, setActiveSubpage] = useState<SettingsSubpage | null>(
		null,
	);
	const { t } = useTranslation();

	// 首选项内容区：滚轮平滑滚动（与顶部菜单栏共用同一实现，方向为纵向）
	// 滚动容器在弹窗打开时才挂载，用回调 ref + 状态确保节点一出现就绑定监听
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null);
	const setScrollRef = useCallback((node: HTMLDivElement | null) => {
		scrollRef.current = node;
		setScrollNode(node);
	}, []);
	useSmoothWheelScroll(scrollRef, {
		axis: "y",
		deps: [scrollNode],
	});

	const tabConfig = useMemo(
		() => [
			{
				value: "common",
				icon: Settings24Regular,
				label: t("settingsDialog.tab.general", "常规"),
			},
			{
				value: "keybinding",
				icon: Keyboard24Regular,
				label: t("settingsDialog.tab.keybindings", "按键绑定"),
			},
			{
				value: "personalization",
				icon: PaintBrush24Regular,
				label: t("settingsDialog.tab.appearance", "个性化"),
			},
			{
				value: "about",
				icon: Info24Regular,
				label: t("settingsDialog.tab.about", "关于"),
			},
		],
		[t],
	);

	const activeTabConfig =
		tabConfig.find((tab) => tab.value === activeTab) ?? tabConfig[0];
	const activeTabTitle = activeTabConfig.label;
	const subpageTitle =
		activeTab === "personalization"
			? activeSubpage === "customBackground"
				? t("settings.common.customBackground", "自定义背景")
				: activeSubpage === "customPalette"
					? t("settings.spectrogram.customPaletteTitle", "自定义频谱图配色")
					: null
			: null;
	const onSubpageChange = (nextSubpage: SettingsSubpage | null) => {
		setActiveSubpage(nextSubpage);
	};

	return (
		<Dialog.Root open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
			<Dialog.Content
					className={`${styles.dialogContent} amll-settings-root`}
				>
				<Dialog.Title className={styles.srOnly}>
					{t("settingsDialog.title", "首选项")}
				</Dialog.Title>

				<aside className={styles.sidebar}>
					<Text as="div" weight="bold" size="2" className={styles.sidebarTitle}>
						{t("settingsDialog.title", "首选项")}
					</Text>
					<nav className={styles.navList}>
						{tabConfig.map((tab) => {
							const Icon = tab.icon;
							const selected = activeTab === tab.value;

							return (
								<button
									key={tab.value}
									type="button"
									className={styles.navItem}
									data-active={selected || undefined}
									onClick={() => {
										setActiveSubpage(null);
										setActiveTab(tab.value);
									}}
								>
									<Icon className={styles.navIcon} />
									<span>{tab.label}</span>
								</button>
							);
						})}
					</nav>
				</aside>

				<section className={styles.mainPane}>
					<header className={styles.header}>
						<Heading size="7" className={styles.pageTitle}>
							<span className={styles.titleText}>
								{subpageTitle ? (
									<button
										type="button"
										className={styles.titleButton}
										onClick={() => onSubpageChange(null)}
									>
										{activeTabTitle}
									</button>
								) : (
									<span>{activeTabTitle}</span>
								)}
								{subpageTitle && (
									<>
										<span className={styles.titleSeparator}>{">"}</span>
										<span className={styles.titleCurrent}>{subpageTitle}</span>
									</>
								)}
							</span>
						</Heading>
					</header>

					<Box className={styles.scrollContent} ref={setScrollRef}>
						<AnimatePresence mode="wait" initial={false}>
							<motion.div
								key={activeTab}
								className={styles.contentTransition}
								variants={contentVariants}
								initial="initial"
								animate="animate"
								transition={contentTransition}
							>
								{activeTab === "common" && <SettingsCommonTab />}
								{activeTab === "keybinding" && <SettingsKeyBindingsDialog />}
								{activeTab === "personalization" && (
									<SettingsPersonalizationTab
										subpage={activeSubpage}
										onSubpageChange={onSubpageChange}
									/>
								)}
								{activeTab === "about" && <SettingsAboutTab />}
							</motion.div>
						</AnimatePresence>
					</Box>
				</section>
			</Dialog.Content>
		</Dialog.Root>
	);
});
