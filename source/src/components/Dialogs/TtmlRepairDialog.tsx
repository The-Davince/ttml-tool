import { Warning24Regular, Wrench24Regular } from "@fluentui/react-icons";
import {
	Badge,
	Button,
	Callout,
	Dialog,
	Flex,
	Heading,
	Text,
} from "@radix-ui/themes";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import { repairTTML, ttmlToAmll } from "$/modules/ttml-processor";
import {
	ttmlErrorDialogAtom,
	ttmlRepairDialogAtom,
} from "$/states/dialogs.ts";
import styles from "./TtmlRepairDialog.module.css";

/**
 * 导入错误处理
 */
export const TtmlRepairDialog = () => {
	const [dialogState, setDialogState] = useAtom(ttmlRepairDialogAtom);
	const setTtmlErrorDialog = useSetAtom(ttmlErrorDialogAtom);
	const { t } = useTranslation();

	const error = dialogState?.error;
	const rawText = dialogState?.rawText;

	const localizedKindMsg = useMemo(() => {
		if (!error) return "";
		switch (error.kind) {
			case "AttrError":
				return t("error.ttml.kind.AttrError", "XML 属性解析错误");
			case "EntityError":
				return t("error.ttml.kind.EntityError", "未知的 XML 实体");
			case "InvalidTimestamp":
				return t("error.ttml.kind.InvalidTimestamp", "时间戳格式无效");
			case "MissingAttribute":
				return t("error.ttml.kind.MissingAttribute", "缺失必需的属性");
			case "UnexpectedEof":
				return t("error.ttml.kind.UnexpectedEof", "文件意外结束");
			case "XmlError":
				return t("error.ttml.kind.XmlError", "XML 语法错误");
			default:
				return t("error.ttml.kind.ParseError", "常规解析错误");
		}
	}, [error, t]);

	const handleClose = useCallback(() => setDialogState(null), [setDialogState]);

	const handleViewDetails = useCallback(() => {
		if (!error) return;
		setDialogState(null);
		setTtmlErrorDialog({ error, rawText });
	}, [error, rawText, setDialogState, setTtmlErrorDialog]);

	const handleRepair = useCallback(() => {
		if (!dialogState || rawText === undefined) return;
		const { text: fixedText } = repairTTML(rawText);
		const retry = ttmlToAmll(fixedText);
		if (retry.success) {
			setDialogState(null);
			toast.success(
				t("error.ttmlRepair.success", "已自动修复 TTML 格式并导入"),
			);
			dialogState.onRepaired?.(fixedText);
		} else {
			// 修复后仍无法解析，回退到详细错误对话框展示剩余问题
			setDialogState(null);
			setTtmlErrorDialog({ error: retry.error, rawText: fixedText });
		}
	}, [dialogState, rawText, setDialogState, setTtmlErrorDialog, t]);

	if (!error) return null;

	return (
		<Dialog.Root open onOpenChange={(open) => !open && handleClose()}>
			<Dialog.Content maxWidth="520px">
				<Flex direction="column" gap="4">
					<Flex gap="3" align="start">
						<div className={styles.iconContainer}>
							<Warning24Regular color="var(--amber-9)" />
						</div>
						<Flex direction="column" gap="1">
							<Heading size="5">
								{t("error.ttmlRepair.title", "检测到 TTML 格式异常")}
							</Heading>
							<Text size="2" color="gray">
								{t("error.ttmlRepair.subtitle", "是否尝试自动修复此文件？")}
							</Text>
						</Flex>
					</Flex>

					<Callout.Root color="orange" variant="soft" size="1">
						<Callout.Icon>
							<Badge color="orange" variant="solid">
								{error.kind}
							</Badge>
						</Callout.Icon>
						<Callout.Text weight="bold" ml="2">
							{localizedKindMsg}
							{error.message ? `: ${error.message}` : ""}
						</Callout.Text>
					</Callout.Root>

					<Text size="2" color="gray">
						{t(
							"error.ttmlRepair.description",
							"自动修复会尝试修正常见格式问题，例如无效的时间戳、未闭合的标签、不兼容的 HTML 实体等。修复后将重新导入歌词。",
						)}
					</Text>

					<Flex gap="3" mt="4" justify="end">
						<Button variant="soft" color="gray" onClick={handleClose}>
							{t("error.ttmlRepair.cancel", "取消")}
						</Button>
						<Button variant="soft" onClick={handleViewDetails}>
							{t("error.ttmlRepair.viewDetails", "查看详情")}
						</Button>
						<Button variant="solid" color="orange" onClick={handleRepair}>
							<Wrench24Regular />
							{t("error.ttmlRepair.repair", "尝试修复")}
						</Button>
					</Flex>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};

export default TtmlRepairDialog;
