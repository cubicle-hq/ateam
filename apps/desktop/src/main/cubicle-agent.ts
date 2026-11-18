import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const CUBICLE_MODEL = "fireworks-ai/accounts/fireworks/models/minimax-m3p1-flash";

/** Only transfer the provider needed for MiniMax, never the user's other logins. */
export async function loadCubicleAgentAuth(): Promise<string> {
	const file = join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
		"opencode/auth.json",
	);
	const auth = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
	return selectCubicleAgentAuth(auth);
}

export function selectCubicleAgentAuth(auth: Record<string, unknown>): string {
	const credential = auth["fireworks-ai"] as { type?: string; key?: string } | undefined;
	if (credential?.type !== "api" || typeof credential.key !== "string" || !credential.key)
		throw new Error(
			"Connect Fireworks AI in OpenCode on this Mac first (opencode auth login) to preauthenticate MiniMax sandboxes.",
		);
	return JSON.stringify({ "fireworks-ai": credential });
}

/** Runs after cloning, so revocable provider credentials never enter the gold snapshot. */
export async function configureCubicleAgent(alias: string, auth: string): Promise<void> {
	if (!/^cb-[a-z0-9-]+$/.test(alias)) throw new Error("Invalid Cubicle SSH alias.");
	const directory = await mkdtemp(join(tmpdir(), "ateam-agent-"));
	const options = [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=20",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
	];
	try {
		await writeFile(join(directory, "auth.json"), auth, { mode: 0o600 });
		await writeFile(
			join(directory, "opencode.json"),
			JSON.stringify({
				$schema: "https://opencode.ai/config.json",
				model: CUBICLE_MODEL,
				small_model: CUBICLE_MODEL,
			}),
			{ mode: 0o600 },
		);
		await exec(
			"ssh",
			[
				...options,
				alias,
				'umask 077; mkdir -p "$HOME/.local/share/opencode" "$HOME/.config/opencode"',
			],
			{ timeout: 60_000 },
		);
		for (const [file, destination] of [
			["auth.json", ".local/share/opencode"],
			["opencode.json", ".config/opencode"],
		] as const) {
			await exec("scp", [...options, join(directory, file), `${alias}:~/${destination}/${file}`], {
				timeout: 60_000,
			});
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
