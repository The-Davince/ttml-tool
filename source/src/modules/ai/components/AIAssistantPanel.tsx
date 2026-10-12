import {
	ArrowLeft20Regular,
	BrainCircuit20Regular,
	Checkmark16Filled,
	ChevronDown20Regular,
	Delete20Regular,
	ErrorCircle20Regular,
	Globe20Regular,
	MusicNote220Regular,
	PersonFeedback20Regular,
	Search20Regular,
	Send20Filled,
	Settings20Regular,
	Sparkle20Regular,
	Sparkle24Filled,
	Stop20Filled,
	Wand20Regular,
} from "@fluentui/react-icons";
import { AnimatePresence, motion } from "framer-motion";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	abortAgentRun,
	getToolLabel,
	resetAgentMemory,
	runAgentTurn,
	testAIConnection,
} from "$/modules/ai/agent";
import {
	AI_PRESETS,
	type AIStep,
	type AITurn,
	aiRunningAtom,
	aiSettingsAtom,
	aiSettingsViewAtom,
	aiTurnsAtom,
	isAIConfigured,
} from "$/modules/ai/states";
import Markdown from "./Markdown";
import styles from "./AIAssistantPanel.module.css";

const StepIcon = ({ step }: { step: AIStep }) => {
	if (step.status === "running") {
		if (step.kind === "thinking")
			return (
				<span className={styles.pulseDots}>
					<span />
					<span />
					<span />
				</span>
			);
		return <span className={styles.spinner} />;
	}
	if (step.status === "error") return <ErrorCircle20Regular />;
	if (step.kind === "thinking") return <BrainCircuit20Regular />;
	if (step.kind === "tool")
		return step.toolName === "search_web" ||
			step.toolName === "read_page" ||
			step.toolName === "search_qq_music" ? (
			<Globe20Regular />
		) : (
			<Wand20Regular />
		);
	return <Checkmark16Filled />;
};

const StepRow = ({ step }: { step: AIStep }) => {
	const { t } = useTranslation();
	const [showArgs, setShowArgs] = useState(false);
	return (
		<div className={styles.step} data-status={step.status}>
			<span className={styles.stepIcon} data-status={step.status}>
				<StepIcon step={step} />
			</span>
			<div className={styles.stepBody}>
				<div className={styles.stepTitle}>
					<span className={styles.stepLabel}>
						{step.kind === "thinking"
							? step.title
							: step.kind === "tool"
								? t("ai.stepCallingTool", {
										defaultValue: "调用工具：{label}",
										label: getToolLabel(step.toolName ?? ""),
									})
								: step.title}
					</span>
					{step.durationMs !== undefined && (
						<span className={styles.duration}>
							{(step.durationMs / 1000).toFixed(1)}s
						</span>
					)}
					{step.kind === "tool" && step.argsJson && (
						<button
							type="button"
							className={styles.argsToggle}
							onClick={() => setShowArgs((v) => !v)}
						>
							{showArgs
								? t("ai.hideArgs", "收起参数")
								: t("ai.showArgs", "参数")}
						</button>
					)}
				</div>
				{step.detail && (
					<div className={styles.stepDetail} data-status={step.status}>
						{step.detail}
					</div>
				)}
				{showArgs && step.argsJson && (
					<div className={styles.argsJson}>{step.argsJson}</div>
				)}
			</div>
		</div>
	);
};

const StepsCard = ({ turn }: { turn: AITurn }) => {
	const { t } = useTranslation();
	const running = turn.status === "running";
	const [expanded, setExpanded] = useState(running);
	useEffect(() => {
		if (running) setExpanded(true);
	}, [running]);
	if (turn.steps.length === 0) return null;
	const totalMs = turn.steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
	const toolCount = turn.steps.filter((s) => s.kind === "tool").length;
	return (
		<div className={styles.stepsCard} data-expanded={expanded || undefined}>
			<button
				type="button"
				className={styles.stepsHeader}
				onClick={() => setExpanded((v) => !v)}
			>
				<span className={styles.stepsHeaderIcon}>
					{running ? (
						<span className={styles.spinner} />
					) : (
						<BrainCircuit20Regular />
					)}
				</span>
				<span className={styles.stepsHeaderText}>
					{running
						? t("ai.executing", "执行中…")
						: t("ai.stepsSummary", {
								defaultValue: "{count} 个步骤 · {time}",
								count: toolCount,
								time: `${(totalMs / 1000).toFixed(1)}s`,
							})}
				</span>
				<ChevronDown20Regular className={styles.chevron} />
			</button>
			{expanded && (
				<div className={styles.stepsBody}>
					{turn.steps.map((step) => (
						<StepRow key={step.id} step={step} />
					))}
				</div>
			)}
		</div>
	);
};

const TurnView = ({ turn }: { turn: AITurn }) => {
	const { t } = useTranslation();
	return (
		<>
			<div className={styles.userRow}>
				<div className={styles.userBubble}>{turn.userText}</div>
			</div>
			<StepsCard turn={turn} />
			{turn.answer && (
				<div className={styles.answerBubble}>
					<Markdown text={turn.answer} />
					{turn.streaming && (
						<span className={styles.caret} aria-hidden="true" />
					)}
				</div>
			)}
			{turn.status === "error" && turn.error && !turn.answer && (
				<div className={styles.errorCard}>
					{t("ai.errorPrefix", "出错了：")}
					{turn.error}
				</div>
			)}
			{turn.status === "aborted" && !turn.answer && (
				<div className={styles.errorCard}>
					{t("ai.aborted", "已停止生成（本次未产生回答）")}
				</div>
			)}
		</>
	);
};

const QUICK_ACTIONS = [
	{
		icon: <MusicNote220Regular />,
		labelKey: "ai.quick.importQQLyric",
		labelDefault: "导入 QQ 音乐歌词",
		text: "请在 QQ 音乐搜索当前这首歌（用元数据里的歌名作为关键词），找到最匹配的版本后用 import_qq_lyric 导入它的官方歌词。",
	},
	{
		icon: <Search20Regular />,
		labelKey: "ai.quick.searchSong",
		labelDefault: "搜索这首歌的信息",
		text: "请搜索这首歌（按元数据里的歌名和歌手）的详细信息，告诉我歌手、专辑、发行时间等。",
	},
	{
		icon: <Sparkle20Regular />,
		labelKey: "ai.quick.autoRuby",
		labelDefault: "自动标注假名",
		text: "请为当前歌词中所有没有假名注音的音节标注日语假名读音（优先用 batch_set_ruby 批量处理），已有假名的跳过。",
	},
	{
		icon: <MusicNote220Regular />,
		labelKey: "ai.quick.autoRomaji",
		labelDefault: "生成罗马音",
		text: "请为当前歌词自动生成罗马音：没有假名的先标注假名，再调用 auto_romaji 转换为罗马音。",
	},
	{
		icon: <PersonFeedback20Regular />,
		labelKey: "ai.quick.mergeLines",
		labelDefault: "检查合并行",
		text: "请检查歌词中是否有被错误拆分的行（一句话被拆成多行、或连续行明显属于同一句），如果有就合并它们。",
	},
	{
		icon: <Globe20Regular />,
		labelKey: "ai.quick.translate",
		labelDefault: "翻译为中文",
		text: "请把当前歌词逐行翻译成中文，并用 set_line_translation 写入每行的翻译。",
	},
];

const SettingsView = ({ onBack }: { onBack: () => void }) => {
	const { t } = useTranslation();
	const [settings, setSettings] = useAtom(aiSettingsAtom);
	const [baseURL, setBaseURL] = useState(settings.baseURL);
	const [model, setModel] = useState(settings.model);
	const [apiKey, setApiKey] = useState(settings.apiKey);
	const [backendBaseURL, setBackendBaseURL] = useState(
		settings.backendBaseURL ?? "",
	);
	const [useProxyOnly, setUseProxyOnly] = useState(
		settings.useProxyOnly ?? false,
	);
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<{
		ok: boolean;
		message: string;
	} | null>(null);

	const applyPreset = (preset: { baseURL: string; model: string }) => {
		setBaseURL(preset.baseURL);
		setModel(preset.model);
	};

	useEffect(() => {
		setBaseURL(settings.baseURL);
		setModel(settings.model);
		setApiKey(settings.apiKey);
		setBackendBaseURL(settings.backendBaseURL ?? "");
		setUseProxyOnly(settings.useProxyOnly ?? false);
	}, [
		settings.baseURL,
		settings.model,
		settings.apiKey,
		settings.backendBaseURL,
		settings.useProxyOnly,
	]);

	const save = () => {
		setSettings({
			...settings,
			baseURL: baseURL.trim(),
			model: model.trim(),
			apiKey: apiKey.trim(),
			backendBaseURL: backendBaseURL.trim(),
			useProxyOnly,
		});
		toast.success(t("ai.saved", "已保存 AI 设置"));
	};

	const test = async () => {
		setTesting(true);
		setTestResult(null);
		const result = await testAIConnection({
			...settings,
			baseURL: baseURL.trim(),
			model: model.trim(),
			apiKey: apiKey.trim(),
			backendBaseURL: backendBaseURL.trim(),
			useProxyOnly,
		});
		setTestResult(result);
		setTesting(false);
	};

	return (
		<div className={styles.settingsView}>
			<div className={styles.settingsTitle}>
				<Sparkle24Filled />
				{t("ai.settingsTitle", "AI 助手设置")}
			</div>

			<div className={styles.field}>
				<span className={styles.fieldLabel}>
					{t("ai.presetLabel", "快速选择服务商")}
				</span>
				<div className={styles.presetGrid}>
					{AI_PRESETS.map((preset) => (
						<button
							key={preset.name}
							type="button"
							className={styles.presetChip}
							title={preset.note}
							onClick={() => applyPreset(preset)}
						>
							{preset.name}
						</button>
					))}
				</div>
			</div>

			<div className={styles.field}>
				<label className={styles.fieldLabel} htmlFor="ai-base-url">
					{t("ai.baseURLLabel", "API Base URL")}
				</label>
				<input
					id="ai-base-url"
					className={styles.fieldInput}
					placeholder="https://open.bigmodel.cn/api/paas/v4"
					value={baseURL}
					onChange={(e) => setBaseURL(e.target.value)}
				/>
			</div>

			<div className={styles.field}>
				<label className={styles.fieldLabel} htmlFor="ai-model">
					{t("ai.modelLabel", "模型名称")}
				</label>
				<input
					id="ai-model"
					className={styles.fieldInput}
					placeholder="glm-4-flash"
					value={model}
					onChange={(e) => setModel(e.target.value)}
				/>
				<span className={styles.fieldHint}>
					{t("ai.modelHint", "需要选择支持工具调用（Function Calling）的模型")}
				</span>
			</div>

			<div className={styles.field}>
				<label className={styles.fieldLabel} htmlFor="ai-key">
					{t("ai.apiKeyLabel", "API Key")}
				</label>
				<input
					id="ai-key"
					className={styles.fieldInput}
					type="password"
					placeholder="sk-..."
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
				/>
			</div>

			<div className={styles.field}>
				<label className={styles.fieldLabel} htmlFor="ai-backend-url">
					{t("ai.backendURLLabel", "后端代理地址 (server.py)")}
				</label>
				<input
					id="ai-backend-url"
					className={styles.fieldInput}
					placeholder="留空或当前网页地址 = 同源 /api"
					value={backendBaseURL}
					onChange={(e) => setBackendBaseURL(e.target.value)}
				/>
				<span className={styles.fieldHint}>
					{t(
						"ai.backendURLHint",
						"默认取当前网页地址（同源 server.py）；本地开发留空亦可（Vite 已把 /api 代理到 server.py）。若前端与后端不同源，在此填写后端完整地址（需后端开启 CORS）。",
					)}
				</span>
			</div>

			<div className={styles.field}>
				<label className={styles.checkboxRow} htmlFor="ai-proxy-only">
					<input
						id="ai-proxy-only"
						type="checkbox"
						checked={useProxyOnly}
						onChange={(e) => setUseProxyOnly(e.target.checked)}
					/>
					{t("ai.useProxyOnlyLabel", "始终通过后端代理（忽略直连）")}
				</label>
				<span className={styles.fieldHint}>
					{t(
						"ai.useProxyOnlyHint",
						"直连端点担心偶发 HTTP 500 / 被浏览器 CORS 拦截时，勾选此项强制所有请求走带重试的后端代理，更稳定。",
					)}
				</span>
			</div>

			<div className={styles.settingsActions}>
				<button type="button" className={styles.saveButton} onClick={save}>
					{t("ai.save", "保存设置")}
				</button>
				<button
					type="button"
					className={styles.testButton}
					disabled={testing}
					onClick={test}
				>
					{testing ? t("ai.testing", "测试中…") : t("ai.test", "测试连接")}
				</button>
			</div>

			{testResult && (
				<div className={styles.testResult} data-ok={testResult.ok}>
					{testResult.message}
				</div>
			)}

			<div className={styles.privacyNote}>
				{t(
					"ai.privacyNote",
					"API Key 仅保存在本地浏览器中，通过本地启动器转发给对应的 AI 服务商；对话与歌词内容会发送给你配置的模型服务商。Ollama 本地部署无需 Key。",
				)}
			</div>

			<button
				type="button"
				className={styles.testButton}
				style={{ alignSelf: "flex-start" }}
				onClick={onBack}
			>
				<ArrowLeft20Regular style={{ marginRight: 4, verticalAlign: "-3px" }} />
				{t("ai.backToChat", "返回对话")}
			</button>
		</div>
	);
};

/** AI助手标签页 */
export const AIAssistantPanel = () => {
	const { t } = useTranslation();
	const settings = useAtomValue(aiSettingsAtom);
	const turns = useAtomValue(aiTurnsAtom);
	const running = useAtomValue(aiRunningAtom);
	const [settingsView, setSettingsView] = useAtom(aiSettingsViewAtom);
	const setTurns = useSetAtom(aiTurnsAtom);
	const [input, setInput] = useState("");
	const chatRef = useRef<HTMLDivElement>(null);
	const configured = isAIConfigured(settings);

	const stickToBottomRef = useRef(true);
	const onChatScroll = useCallback(() => {
		const el = chatRef.current;
		if (!el) return;
		stickToBottomRef.current =
			el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	}, []);
	useEffect(() => {
		const el = chatRef.current;
		if (el && stickToBottomRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [turns]);

	useEffect(() => {
		if (!configured) setSettingsView(true);
	}, [configured, setSettingsView]);

	const send = useCallback(
		(text?: string) => {
			const content = (text ?? input).trim();
			if (!content || running) return;
			if (!configured) {
				setSettingsView(true);
				toast.info(t("ai.needConfig", "请先配置 AI 接口"));
				return;
			}
			setInput("");
			stickToBottomRef.current = true;
			runAgentTurn(settings, content).catch((e) => {
				toast.error(String(e));
			});
		},
		[input, running, configured, settings, setSettingsView, t],
	);

	const showSettings = settingsView || !configured;

	return (
		<div className={styles.panel}>
			{showSettings ? (
				<SettingsView onBack={() => setSettingsView(false)} />
			) : (
				<>
					<header className={styles.header}>
						<span className={styles.headerIcon}>
							<Sparkle24Filled />
						</span>
						<span className={styles.headerTitle}>
							{t("ai.title", "AI 助手")}
						</span>
						{settings.model && (
							<span className={styles.modelChip} title={settings.model}>
								<span className={styles.statusDot} />
								{settings.model}
							</span>
						)}
						<div className={styles.headerButtons}>
							<button
								type="button"
								className={styles.iconButton}
								title={t("ai.newChat", "开启新对话")}
								onClick={() => {
									resetAgentMemory();
									setTurns([]);
									stickToBottomRef.current = true;
								}}
							>
								<Delete20Regular />
							</button>
							<button
								type="button"
								className={styles.iconButton}
								title={t("ai.settings", "AI 设置")}
								onClick={() => setSettingsView(true)}
							>
								<Settings20Regular />
							</button>
						</div>
					</header>

					<div
						className={styles.chatArea}
						ref={chatRef}
						onScroll={onChatScroll}
					>
						{turns.length === 0 ? (
							<div className={styles.welcome}>
								<div className={styles.welcomeIcon}>
									<Sparkle24Filled />
								</div>
								<div className={styles.welcomeTitle}>
									{t("ai.welcomeTitle", "我能帮你做什么？")}
								</div>
								<div className={styles.welcomeDesc}>
									{t(
										"ai.welcomeDesc",
										"试着让我导入一首歌的 QQ 音乐歌词、合并歌词行、给音节标注假名、生成罗马音、翻译歌词，或者搜索一首歌的信息。",
									)}
								</div>
								<div className={styles.quickActions}>
									{QUICK_ACTIONS.map((action) => (
										<button
											key={action.labelKey}
											type="button"
											className={styles.quickChip}
											onClick={() => send(action.text)}
										>
											{action.icon}
											{t(action.labelKey, action.labelDefault)}
										</button>
									))}
								</div>
							</div>
						) : (
							<AnimatePresence initial={false}>
								{turns.map((turn) => (
									<motion.div
										key={turn.id}
										className={styles.turnGroup}
										initial={{ opacity: 0, y: 8 }}
										animate={{ opacity: 1, y: 0 }}
										transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
									>
										<TurnView turn={turn} />
									</motion.div>
								))}
							</AnimatePresence>
						)}
					</div>

					<div className={styles.inputArea}>
						<div className={styles.inputRow}>
							<textarea
								className={styles.textInput}
								placeholder={t(
									"ai.inputPlaceholder",
									"输入指令，Enter 发送，Shift+Enter 换行",
								)}
								rows={1}
								value={input}
								onChange={(e) => {
									setInput(e.target.value);
									const el = e.target;
									el.style.height = "auto";
									el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
								}}
								onKeyDown={(e) => {
									if (
										e.key === "Enter" &&
										!e.shiftKey &&
										!e.nativeEvent.isComposing
									) {
										e.preventDefault();
										send();
									}
								}}
							/>
							{running ? (
								<button
									type="button"
									className={styles.stopButton}
									title={t("ai.stop", "停止")}
									onClick={abortAgentRun}
								>
									<Stop20Filled />
								</button>
							) : (
								<button
									type="button"
									className={styles.sendButton}
									title={t("ai.send", "发送")}
									disabled={!input.trim()}
									onClick={() => send()}
								>
									<Send20Filled />
								</button>
							)}
						</div>
						<div className={styles.inputHint}>
							{t("ai.inputHint", "Enter 发送 · Shift+Enter 换行")}
						</div>
					</div>
				</>
			)}
		</div>
	);
};

export default AIAssistantPanel;
