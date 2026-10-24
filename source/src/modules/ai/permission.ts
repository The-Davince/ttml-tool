import { atomWithStorage } from "jotai/utils";

export type AIPermissionMode = "confirm" | "full";

export const aiPermissionModeAtom = atomWithStorage<AIPermissionMode>(
	"aiPermissionMode",
	"confirm",
);
