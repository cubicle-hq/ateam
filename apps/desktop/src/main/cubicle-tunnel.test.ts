import { expect, test } from "bun:test";
import { CubicleTunnelError, classifyTunnelFailure, createTunnel } from "./cubicle-tunnel";

const HELPER_DOWN =
	"Command failed: cubicle connect the Cubicle tunnel helper is not responding; reinstall it with `cubicle tunnel install`";
const NOT_INSTALLED = "the Cubicle tunnel is not installed; run `cubicle tunnel install`";
const SESSION = "session_expired: VPN session expired; reconnect";

/** A CLI whose `connect` answers from a script: an error message, or null for success. */
function fixture(connects: (string | null)[]) {
	const calls: string[] = [];
	let repairs = 0;
	let repairFails: string | null = null;
	const tunnel = createTunnel({
		cli: async (args) => {
			calls.push(args.join(" "));
			if (args[0] !== "connect") return "";
			const next = connects.shift();
			if (next === undefined) throw new Error("unexpected connect");
			if (next !== null) throw new Error(next);
			return "connected";
		},
		repair: async () => {
			repairs++;
			calls.push("repair");
			if (repairFails) throw new Error(repairFails);
		},
		sleep: async () => {},
	});
	return {
		tunnel,
		calls,
		repairs: () => repairs,
		failRepair: (why: string) => {
			repairFails = why;
		},
	};
}

test("names what a failed connect means from the CLI's own words", () => {
	expect(classifyTunnelFailure(HELPER_DOWN)).toBe("helper_down");
	expect(classifyTunnelFailure(NOT_INSTALLED)).toBe("not_installed");
	expect(classifyTunnelFailure(SESSION)).toBe("session");
	expect(classifyTunnelFailure("spawn cubicle ENOENT")).toBe("cli_missing");
	expect(classifyTunnelFailure("something else")).toBe("unknown");
});

test("a working tunnel is one call and no prompt", async () => {
	const f = fixture([null]);
	await f.tunnel.ensure({ interactive: true });
	expect(f.calls).toEqual(["connect"]);
});

test("a stale session is dropped and connected again without asking anyone", async () => {
	const f = fixture([SESSION, null]);
	const stages: string[] = [];
	await f.tunnel.ensure({ progress: (stage) => stages.push(stage) });
	expect(f.calls).toEqual(["connect", "disconnect", "connect"]);
	expect(f.repairs()).toBe(0);
	expect(stages).toEqual(["Reconnecting the private Cubicle network"]);
});

test("a dead helper is repaired when a person is waiting, and only then", async () => {
	const background = fixture([HELPER_DOWN]);
	const failure = await background.tunnel.ensure().catch((error) => error);
	expect(failure).toBeInstanceOf(CubicleTunnelError);
	expect(failure.fault).toBe("helper_down");
	expect(failure.message).not.toContain("cubicle tunnel install");
	expect(background.repairs()).toBe(0);

	// launchd starts the helper a moment after the repair: the first connect may still miss it.
	const asked = fixture([HELPER_DOWN, HELPER_DOWN, null]);
	await asked.tunnel.ensure({ interactive: true });
	expect(asked.calls).toEqual(["connect", "repair", "connect", "connect"]);

	const missing = fixture([NOT_INSTALLED, null]);
	await missing.tunnel.ensure({ interactive: true });
	expect(missing.repairs()).toBe(1);
});

test("declining the administrator prompt is reported as that, not as a broken tunnel", async () => {
	const f = fixture([HELPER_DOWN]);
	f.failRepair("execution error: User canceled. (-128)");
	const failure = await f.tunnel.ensure({ interactive: true }).catch((error) => error);
	expect(failure.fault).toBe("cancelled");
	expect(failure.message).toContain("prompt was cancelled");
});

test("concurrent callers share one run, and a person is not answered by a background failure", async () => {
	const shared = fixture([null]);
	await Promise.all([shared.tunnel.ensure(), shared.tunnel.ensure(), shared.tunnel.ensure()]);
	expect(shared.calls).toEqual(["connect"]);

	const f = fixture([HELPER_DOWN, HELPER_DOWN, null]);
	const background = f.tunnel.ensure().catch((error) => error);
	const person = f.tunnel.ensure({ interactive: true });
	expect((await background).fault).toBe("helper_down");
	await person;
	expect(f.repairs()).toBe(1);
});

test("a fresh connection drops the session even when the tunnel says it is connected", async () => {
	const f = fixture([null]);
	await f.tunnel.ensure({ fresh: true });
	expect(f.calls).toEqual(["disconnect", "connect"]);
});
