import { useEffect, type RefObject } from "react";

/**
 * 把滚轮输入转换成带惯性缓动的平滑滚动（rAF 逐帧逼近目标位置）。
 *
 * 与浏览器原生逐格滚动相比，鼠标滚轮的跳变会被摊平成连续动画；目标位置始终
 * 钳制在 [0, scrollSize - clientSize] 边界内，不会滚过头、到边即停。
 *
 * - axis "x"：横向（顶部工具/菜单栏，滚轮上下或触控板左右皆可平移）
 * - axis "y"：纵向（首选项等内容区）
 *
 * 为保证可靠 `preventDefault`（阻止页面/父级同时滚动），使用非被动原生监听。
 * 只有"自身会消费滚轮"的表单字段（数字框滚轮调值等）才让滚轮归它处理；
 * 按钮 / 开关 / 分段控件 / 滑块等并不响应滚轮，应继续让容器平滑滚动，否则在
 * 控件密集的面板里会出现"滚不动 / 忽动忽停"。
 */
export const useSmoothWheelScroll = (
	ref: RefObject<HTMLElement | null>,
	opts?: { axis?: "x" | "y"; factor?: number; deps?: readonly unknown[] },
) => {
	const axis = opts?.axis ?? "y";
	const factor = opts?.factor ?? 0.2;
	const deps = opts?.deps;

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const isX = axis === "x";
		// 仅这些控件自身响应滚轮，指针在其上时不接管；带 data-no-smooth-scroll 的区域也可豁免
		const WHEEL_FIELD =
			'input, textarea, select, [contenteditable="true"], [data-no-smooth-scroll]';

		const getPos = () => (isX ? el.scrollLeft : el.scrollTop);
		const setPos = (v: number) => {
			if (isX) el.scrollLeft = v;
			else el.scrollTop = v;
		};
		const maxScroll = () =>
			isX
				? el.scrollWidth - el.clientWidth
				: el.scrollHeight - el.clientHeight;
		const clamp = (v: number) => Math.max(0, Math.min(maxScroll(), v));

		let target = getPos();
		let rafId = 0;
		const step = () => {
			// 每帧重新钳制：内容/尺寸变化时也能收敛到真正的边界，避免空转或"弹回"
			target = clamp(target);
			const current = getPos();
			const diff = target - current;
			if (Math.abs(diff) < 0.5) {
				setPos(target);
				rafId = 0;
				return;
			}
			setPos(current + diff * factor);
			rafId = requestAnimationFrame(step);
		};

		const handleWheel = (e: WheelEvent) => {
			// 对应方向没有溢出时无需接管，交还给页面正常滚动
			if (maxScroll() <= 0) return;

			const hovered = e.target as HTMLElement | null;
			if (
				hovered &&
				typeof hovered.closest === "function" &&
				hovered.closest(WHEEL_FIELD)
			)
				return;

			const raw = isX
				? Math.abs(e.deltaX) > Math.abs(e.deltaY)
					? e.deltaX
					: e.deltaY
				: e.deltaY;
			if (!raw) return;

			const page = isX ? el.clientWidth : el.clientHeight;
			const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? page : 1;
			// 动画空闲时以实际位置为准，避免用户拖动滚动条后目标脱节
			if (!rafId) target = getPos();
			target = clamp(target + raw * unit);
			e.preventDefault();
			if (!rafId) rafId = requestAnimationFrame(step);
		};

		el.addEventListener("wheel", handleWheel, { passive: false });
		return () => {
			el.removeEventListener("wheel", handleWheel);
			if (rafId) cancelAnimationFrame(rafId);
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: deps 展开进依赖，允许调用方在滚动容器延迟挂载（如对话框打开）时重新绑定监听
	}, [ref, axis, factor, ...(deps ?? [])]);
};
