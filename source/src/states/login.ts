import { atomWithStorage } from "jotai/utils";

export interface LoginSession {
	username: string;
	loginTime: number;
}

export const loginSessionAtom = atomWithStorage<LoginSession | null>(
	"amllLoginSession",
	null,
);
