// The engine this app ships with, sent to a box over SSH instead of downloaded from a
// GitHub release. A box then runs exactly the engine its desktop was built with, and a
// build with no release behind it (a fork, a dev build) can still set a box up.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type EngineBundle = { tarball: string; installer: string };

/** Where the bundle lands on the box, relative to its home directory. */
export const ENGINE_BUNDLE_DIR = ".ateam-install";

/**
 * The first root that holds both the engine tarball and its installer. A root is either
 * the packaged layout (both files side by side) or the server package of a checkout
 * (`dist/ateam-server.tar.gz` and `scripts/install.sh`).
 */
export function findEngineBundle(
	roots: (string | undefined)[],
	exists: (path: string) => boolean = existsSync,
): EngineBundle | undefined {
	for (const root of roots) {
		if (!root) continue;
		for (const [tarball, installer] of [
			["ateam-server.tar.gz", "install.sh"],
			["dist/ateam-server.tar.gz", "scripts/install.sh"],
		] as const) {
			const found = { tarball: join(root, tarball), installer: join(root, installer) };
			if (exists(found.tarball) && exists(found.installer)) return found;
		}
	}
	return undefined;
}

/** The roots to look in: an override, the packaged app's resources, then this checkout. */
export function engineBundleRoots(mainDir: string): (string | undefined)[] {
	return [
		process.env.ATEAM_ENGINE_BUNDLE,
		process.resourcesPath ? join(process.resourcesPath, "ateam-engine") : undefined,
		join(mainDir, "../../../../packages/server"),
	];
}

/** Copy the bundle to `dest:~/.ateam-install/`. `sshFlags` are ssh `-o` options. */
export async function sendEngineBundle(
	dest: string,
	bundle: EngineBundle,
	sshFlags: string[],
	run: (file: string, args: string[]) => Promise<unknown> = (file, args) =>
		exec(file, args, { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 }),
): Promise<void> {
	const options = [
		...sshFlags,
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
		await run("ssh", [...options, dest, `mkdir -p ${ENGINE_BUNDLE_DIR}`]);
		await run("scp", [
			...options,
			"-q",
			bundle.tarball,
			bundle.installer,
			`${dest}:${ENGINE_BUNDLE_DIR}/`,
		]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Setup of "${dest}" failed: the Ateam engine could not be copied. ${detail}`);
	}
}

/**
 * The shell that installs from a bundle already on the box, in place of
 * `curl … | bash -s --`. Free of single quotes: it runs inside `bash -lc '…'`.
 */
export function bundledInstall(env: string, flags: string): string {
	const dir = `"$HOME/${ENGINE_BUNDLE_DIR}"`;
	return (
		`${env}ATEAM_TARBALL="$HOME/${ENGINE_BUNDLE_DIR}/ateam-server.tar.gz" ` +
		`bash "$HOME/${ENGINE_BUNDLE_DIR}/install.sh" ${flags}; ` +
		`code=$?; rm -rf ${dir}; exit $code`
	);
}
