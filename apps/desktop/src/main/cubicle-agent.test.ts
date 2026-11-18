import { expect, test } from "bun:test";
import { CUBICLE_MODEL, cubicleOpencodeConfig, selectCubicleAgentAuth } from "./cubicle-agent";

test("MiniMax clones receive only the selected provider credential", () => {
	const auth = selectCubicleAgentAuth({
		"fireworks-ai": { type: "api", key: "selected" },
		openai: { type: "oauth", access: "unrelated" },
		opencode: { type: "api", key: "expired" },
	});
	expect(JSON.parse(auth)).toEqual({ "fireworks-ai": { type: "api", key: "selected" } });
	expect(CUBICLE_MODEL).toBe("fireworks-ai/accounts/fireworks/models/minimax-m3p1-flash");
	expect(() => selectCubicleAgentAuth({})).toThrow("Connect Fireworks");
	expect(() => selectCubicleAgentAuth({ "fireworks-ai": { type: "api", key: "" } })).toThrow();
});

test("OpenCode on a Box never asks, also outside the task's worktree", () => {
	const config = cubicleOpencodeConfig();
	expect(config.model).toBe(CUBICLE_MODEL);
	expect(config.permission).toEqual({
		"*": "allow",
		external_directory: "allow",
		doom_loop: "allow",
	});
});
