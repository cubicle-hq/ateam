// The one place that knows how this Mac reaches a Cubicle Box. Today that is the
// CLI's WireGuard tunnel, which depends on a root helper that can stop answering
// (unloaded by macOS, replaced by another CLI version, an expired session). Every
// caller asks `ensure()` before it needs the network, so a broken tunnel is found
// before a Box is allocated and is repaired here instead of surfacing as a raw CLI
// error. Cubicle's rootless SSH gateway (CB-35) replaces this module, not its callers.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type TunnelFault =
	| "not_installed"
	| "helper_down"
	| "session"
	| "cli_missing"
	| "cancelled"
	| "unknown";

/** What a failed `cubicle connect` means, from the CLI's own words. */
export function classifyTunnelFailure(message: string): TunnelFault {
	if (/ENOENT|command not found|spawn .* ENOENT/i.test(message)) return "cli_missing";
	if (/tunnel is not installed/i.test(message)) return "not_installed";
	if (/helper is not responding|helper timed out|oversized helper response/i.test(message))
		return "helper_down";
	if (
		/session[_ ]expired|reconnect|VPN startup timed out|device key|already registered|handshake/i.test(
			message,
		)
	)
		return "session";
	return "unknown";
}

const ADVICE: Record<TunnelFault, string> = {
	not_installed: "Cubicle's network helper is not installed on this Mac.",
	helper_down: "Cubicle's network helper stopped running on this Mac.",
	session: "The private connection to Cubicle could not be re-established. Try again in a moment.",
	cli_missing: "The Cubicle CLI is missing from this Ateam build. Reinstall Ateam.",
	cancelled:
		"Cubicle's network helper was not repaired because the administrator prompt was cancelled. Try again and approve it.",
	unknown: "The private connection to Cubicle failed.",
};
const MANUAL = "Run `cubicle tunnel install` in Terminal, then try again.";

export class CubicleTunnelError extends Error {
	constructor(
		readonly fault: TunnelFault,
		readonly detail: string,
		/** What to do about it, when this attempt knows more than the fault alone. */
		next = "",
	) {
		super(
			[ADVICE[fault], next, fault === "unknown" && detail ? `(${detail})` : ""]
				.filter(Boolean)
				.join(" "),
		);
	}
}

export interface TunnelDeps {
	/** Run the Cubicle CLI with Ateam's key; rejects with the CLI's message. */
	cli(args: string[]): Promise<string>;
	/** Reinstall and start the root helper. Rejects when the person declines. */
	repair(): Promise<void>;
	sleep?(ms: number): Promise<void>;
}

export interface EnsureOptions {
	/** A person is waiting: an administrator prompt may be shown to repair the helper. */
	interactive?: boolean;
	/** Drop the current session first: SSH stopped answering through a "connected" tunnel. */
	fresh?: boolean;
	progress?(stage: string): void;
}

export function createTunnel({ cli, repair, sleep }: TunnelDeps) {
	const pause = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let running: { interactive: boolean; done: Promise<void> } | null = null;

	const reset = () =>
		cli(["disconnect"]).then(
			() => {},
			() => {},
		);
	/** Null when connected, else why not. */
	async function connect(): Promise<{ fault: TunnelFault; detail: string } | null> {
		try {
			await cli(["connect"]);
			return null;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			return { fault: classifyTunnelFailure(detail), detail };
		}
	}

	// Connect; on a stale session, once more on a clean one; on a dead helper, repair it
	// when a person is waiting. Each step only runs when the one before it failed.
	async function attempt(options: EnsureOptions): Promise<void> {
		if (options.fresh) await reset();
		let failed = await connect();
		if (failed && (failed.fault === "session" || failed.fault === "unknown")) {
			options.progress?.("Reconnecting the private Cubicle network");
			await reset();
			failed = await connect();
		}
		const helper = (fault: TunnelFault) => fault === "helper_down" || fault === "not_installed";
		if (failed && helper(failed.fault)) {
			// Never an administrator prompt nobody asked for: a background connect says what
			// will fix it, and the next thing a person starts does the repair.
			if (!options.interactive)
				throw new CubicleTunnelError(
					failed.fault,
					failed.detail,
					"Open a Cubicle Box or start a sandbox task and Ateam repairs it.",
				);
			options.progress?.("Repairing Cubicle's network helper. macOS asks for your password");
			try {
				await repair();
			} catch (error) {
				const why = error instanceof Error ? error.message : String(error);
				if (/cancel|-128/i.test(why)) throw new CubicleTunnelError("cancelled", why);
				throw new CubicleTunnelError(
					failed.fault,
					why,
					`Ateam could not repair it: ${why.trim().split("\n").pop()} ${MANUAL}`,
				);
			}
			// launchd starts the helper asynchronously: give its socket a moment.
			for (let tries = 0; tries < 10; tries++) {
				failed = await connect();
				if (failed?.fault !== "helper_down") break;
				await pause(1000);
			}
			if (failed && helper(failed.fault))
				throw new CubicleTunnelError(
					failed.fault,
					failed.detail,
					`It still does not answer after a repair. ${MANUAL}`,
				);
		}
		if (failed) throw new CubicleTunnelError(failed.fault, failed.detail);
	}

	/**
	 * Make Boxes reachable, repairing what can be repaired. Concurrent callers share one
	 * run, except that a person's request never settles for a background attempt that
	 * was not allowed to repair.
	 */
	async function ensure(options: EnsureOptions = {}): Promise<void> {
		const interactive = options.interactive === true;
		while (running) {
			const current = running;
			const outcome = await current.done.then(
				() => true,
				() => false,
			);
			if (outcome && !options.fresh) return;
			if (!outcome && (current.interactive || !interactive)) return current.done;
		}
		const done = attempt(options);
		const mine = { interactive, done };
		running = mine;
		try {
			await done;
		} finally {
			if (running === mine) running = null;
		}
	}

	return { ensure };
}

export type Tunnel = ReturnType<typeof createTunnel>;

/** AppleScript string literal. */
const appleString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const shellString = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The helper installer shipped beside a CLI binary (`<bundle>/bin/cubicle`). */
export function tunnelInstaller(cliPath: string): string | undefined {
	try {
		const script = join(dirname(dirname(realpathSync(cliPath))), "scripts", "tunnel.sh");
		return existsSync(script) ? script : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reinstall the root helper from this app's CLI bundle, so the helper always matches
 * the CLI that talks to it. The same script `cubicle tunnel install` runs under sudo;
 * here macOS shows its own administrator prompt.
 */
export async function repairTunnelHelper(cliPath: string): Promise<void> {
	if (process.platform !== "darwin")
		throw new Error("Run `cubicle tunnel install` in a terminal to repair the tunnel.");
	const script = tunnelInstaller(cliPath);
	if (!script)
		throw new Error(
			"This Cubicle CLI has no tunnel installer. Run `cubicle tunnel install` in a terminal.",
		);
	const command = `CB_INSTALL_CLIENT_UID=${userInfo().uid} /bin/sh ${shellString(script)} install`;
	const prompt = "Ateam needs to repair Cubicle's network helper so it can reach your Boxes.";
	await exec(
		"/usr/bin/osascript",
		[
			"-e",
			`do shell script ${appleString(command)} with prompt ${appleString(prompt)} with administrator privileges`,
		],
		{ timeout: 5 * 60_000 },
	);
}
