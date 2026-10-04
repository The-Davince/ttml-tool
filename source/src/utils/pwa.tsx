import { Button, Flex } from "@radix-ui/themes";
import { t } from "i18next";
import { toast } from "react-toastify";
import { registerSW } from "virtual:pwa-register";

// PWA Service Worker 注册。TAURI 桌面端不启用（vite-plugin-pwa 已 disable）。
if (!import.meta.env.TAURI_ENV_PLATFORM) {
	const refresh = registerSW({
		immediate: true,
		onOfflineReady() {
			toast.info(
				t("pwa.offlineReady", "网站已成功离线缓存，后续可离线访问本网页"),
			);
		},
		onNeedRefresh() {
			// 检测到新版本：在站内右上角通知区弹出提示，由用户点“刷新”应用新版。
			toast.info(
				<Flex direction="column" gap="2" align="stretch">
					<div>
						{t("pwa.updateRefresh", "网站已更新，刷新网页以使用最新版本！")}
					</div>
					<Button
						size="2"
						onClick={() => {
							refresh(true);
						}}
					>
						{t("pwa.refresh", "刷新")}
					</Button>
				</Flex>,
			);
		},
		onRegisteredSW(_swUrl, registration) {
			// 每次刷新、以及切回页面/窗口聚焦时都主动查一次更新，
			// 让 prompt 模式能可靠地触发上面的右上角提示（不必干等浏览器的每日检查）。
			if (!registration) return;
			const check = () => {
				void registration.update();
			};
			check();
			window.addEventListener("focus", check);
			document.addEventListener("visibilitychange", () => {
				if (!document.hidden) check();
			});
		},
	});
}
