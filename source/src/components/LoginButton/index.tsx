import { ArrowExit16Regular, PersonCircle16Regular } from "@fluentui/react-icons";
import {
	Button,
	Dialog,
	DropdownMenu,
	Flex,
	TextField,
} from "@radix-ui/themes";
import { useAtom } from "jotai";
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { loginSessionAtom } from "$/states/login.ts";

export const LoginButton = memo(() => {
	const { t } = useTranslation();
	const [session, setSession] = useAtom(loginSessionAtom);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");

	const onLogin = useCallback(() => {
		if (username.trim().length === 0 || password.length === 0) return;
		setSession({ username: username.trim(), loginTime: Date.now() });
		setDialogOpen(false);
		setUsername("");
		setPassword("");
	}, [username, password, setSession]);

	const onLogout = useCallback(() => {
		setSession(null);
	}, [setSession]);

	if (session) {
		return (
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					<Button variant="soft" mr="2" style={{ whiteSpace: "nowrap" }}>
						<PersonCircle16Regular />
						{session.username}
						<DropdownMenu.TriggerIcon />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item color="red" onSelect={onLogout}>
						<ArrowExit16Regular />
						{t("login.logout", "退出登录")}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		);
	}

	return (
		<>
			<Button variant="soft" mr="2" onClick={() => setDialogOpen(true)}>
				<PersonCircle16Regular />
				{t("login.login", "登录")}
			</Button>
			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog.Content
					aria-description={t(
						"login.dialogDescription",
						"登录歌词数据库账号",
					)}
				>
					<Dialog.Title>{t("login.title", "登录")}</Dialog.Title>
					<Flex direction="column" gap="4">
						<TextField.Root
							placeholder={t("login.usernamePlaceholder", "用户名")}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							autoFocus
						/>
						<TextField.Root
							type="password"
							placeholder={t("login.passwordPlaceholder", "密码")}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") onLogin();
							}}
						/>
						<Flex gap="3" justify="end" mt="2">
							<Dialog.Close>
								<Button variant="soft" color="gray">
									{t("login.cancel", "取消")}
								</Button>
							</Dialog.Close>
							<Button
								onClick={onLogin}
								disabled={username.trim().length === 0 || password.length === 0}
							>
								{t("login.confirm", "登录")}
							</Button>
						</Flex>
					</Flex>
				</Dialog.Content>
			</Dialog.Root>
		</>
	);
});

export default LoginButton;
