import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const quoteShell = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Explicit configuration wins; never guess a package manager or install command. */
export async function repositoryInitializer(root: string): Promise<string | undefined> {
	try {
		const config = JSON.parse(await readFile(join(root, ".ateam/sandbox.json"), "utf8"));
		if (config.initializer !== undefined) {
			if (typeof config.initializer !== "string" || !config.initializer.trim())
				throw new Error(".ateam/sandbox.json initializer must be a nonempty command.");
			return config.initializer.trim();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const file of [
		".ateam/init.sh",
		"scripts/init.sh",
		"init.sh",
		"scripts/setup.sh",
		"setup.sh",
	]) {
		if (
			await stat(join(root, file)).then(
				(s) => s.isFile(),
				() => false,
			)
		)
			return `bash ${quoteShell(file)}`;
	}
}

/** An explicit start hook separates one-time setup from per-box processes.
 * Without it, preserve legacy initializers that also start the application. */
export async function repositoryStart(root: string): Promise<string | undefined> {
	try {
		const config = JSON.parse(await readFile(join(root, ".ateam/sandbox.json"), "utf8"));
		if (config.start !== undefined && typeof config.start !== "string")
			throw new Error(".ateam/sandbox.json start must be a command string (or empty).");
		return config.start;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

/** The last commit the Mac sent: everything up to it is on the Box. */
export const PROJECT_BASE_REF = "refs/ateam/base";

export interface RepositorySnapshot {
	directory: string;
	archive: string;
	/** Absent when the Box already holds HEAD (its project image is at or past it). */
	bundle?: string;
	replacedPaths: string;
	head: string;
	origin: string;
	initializer?: string;
	start?: string;
	cleanup(): Promise<void>;
}

/**
 * Git carries committed files and history. The archive carries only working-tree changes.
 * `have` is a commit the Box already holds with all its history (the head its project
 * image was saved at): the bundle then carries only what came after it.
 */
export async function snapshotRepository(
	root: string,
	progress?: (message: string) => void,
	options: { have?: string } = {},
): Promise<RepositorySnapshot> {
	root = await realpath(root);
	const initializer = await repositoryInitializer(root);
	const start = await repositoryStart(root);
	const git = async (...args: string[]) =>
		(await exec("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;
	const head = (await git("rev-parse", "HEAD")).trim();
	const directory = await mkdtemp(join(tmpdir(), "ateam-cubicle-"));
	const cleanup = () => rm(directory, { recursive: true, force: true });
	try {
		let bundle: string | undefined = join(directory, "repository.bundle");
		const archive = join(directory, "changes.tar");
		const replacedPaths = join(directory, "replaced-paths");
		// An abbreviated or unknown commit resolves to nothing here, which means "send it all".
		const have = options.have
			? await git("rev-parse", "--verify", "--quiet", `${options.have}^{commit}`).then(
					(out) => out.trim() || undefined,
					() => undefined,
				)
			: undefined;
		if (!have) {
			progress?.("Your Mac is packaging Git history");
			await git("bundle", "create", bundle, "--all", "HEAD");
		} else if (
			await git("merge-base", "--is-ancestor", head, have).then(
				() => true,
				() => false,
			)
		) {
			bundle = undefined;
		} else {
			progress?.("Your Mac is packaging the commits since the project image");
			await git("bundle", "create", bundle, "HEAD", `^${have}`);
		}
		progress?.("Your Mac is collecting local edits and new files");
		const exclusions = [".ateam/worktrees"];
		const [worktrees, changed, untracked] = await Promise.all([
			git("worktree", "list", "--porcelain", "-z"),
			git("diff", "--name-only", "--no-renames", "--ignore-submodules=all", "-z", head, "--"),
			git("ls-files", "--others", "--exclude-standard", "-z", "--"),
		]);
		for (const line of worktrees.split("\0")) {
			if (!line.startsWith("worktree ")) continue;
			const path = relative(root, line.slice(9));
			if (path && !path.startsWith("../") && path !== "..") exclusions.push(path);
		}
		const paths = [...new Set([...changed.split("\0"), ...untracked.split("\0")])]
			.filter(
				(path) => path && !exclusions.some((dir) => path === dir || path.startsWith(`${dir}/`)),
			)
			.sort();
		const present: string[] = [];
		for (const path of paths) {
			const absolute = join(root, path);
			// A deleted directory can have been replaced by a symlink. Do not read through it.
			const item = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
			});
			if (
				(item?.isFile() || item?.isSymbolicLink()) &&
				(await realpath(dirname(absolute))) === dirname(absolute)
			) {
				present.push(path);
			}
		}
		const list = join(directory, "archive-paths");
		const nulList = (items: string[]) => items.map((path) => `./${path}\0`).join("");
		await Promise.all([
			writeFile(list, nulList(present)),
			writeFile(replacedPaths, nulList(paths)),
		]);
		await exec("tar", ["-cf", archive, "--no-recursion", "-C", root, "--null", "-T", list], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
			maxBuffer: 1024 * 1024,
			timeout: 30 * 60_000,
		});
		return {
			directory,
			archive,
			bundle,
			replacedPaths,
			head,
			origin: (await git("remote", "get-url", "origin").catch(() => "")).trim(),
			initializer,
			start,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

/**
 * Restore the repository after transferring the Git bundle and changes. A Box made from
 * a project image already has the checkout: it only moves to the Mac's HEAD, keeping
 * what project setup left there (dependencies, env files, local edits where possible).
 */
export function restoreRepositoryCommand(
	dir: string,
	snapshot: Pick<RepositorySnapshot, "head" | "origin" | "bundle">,
): string {
	return `set -eu
cd ${quoteShell(dir)}
fresh=
if [ -d repository/.git ]; then
  ${snapshot.bundle ? "git -C repository fetch --no-tags ../repository.bundle HEAD" : ":"}
else
  mkdir -p repository
  git clone --mirror repository.bundle metadata
  mv metadata repository/.git
  fresh=1
fi
cd repository
git config core.bare false
git config --unset remote.origin.mirror || true
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
if [ -n "$fresh" ]; then
  git reset --hard ${quoteShell(snapshot.head)}
  ${applyCheckoutChanges(dir)}
else
  git reset --keep ${quoteShell(snapshot.head)} 2>/dev/null || git reset --hard ${quoteShell(snapshot.head)}
fi
git update-ref ${PROJECT_BASE_REF} ${quoteShell(snapshot.head)}
rm -f ../repository.bundle
${snapshot.origin ? `git remote set-url origin ${quoteShell(snapshot.origin)}` : "git remote remove origin"}`;
}

function applyCheckoutChanges(dir: string): string {
	return `while IFS= read -r -d '' path; do
  rm -rf -- "$path"
done < ${quoteShell(join(dir, "replaced-paths"))}
tar -xf ${quoteShell(join(dir, "changes.tar"))}`;
}

/**
 * The task is new and idle: its worktree is the Mac's HEAD plus what the engine seeded
 * from the main checkout (dependencies, env files). Apply the Mac's uncommitted edits
 * and deletions on top, and keep the seed, which is what makes a project image fast.
 * The project's own hooks run afterwards and separately: their failure is not this one's.
 */
export function initializeWorktreeCommand(
	dir: string,
	worktree: string,
	snapshot: Pick<RepositorySnapshot, "head">,
): string {
	return `set -eu
cd ${quoteShell(worktree)}
test -f .git
git reset --hard ${quoteShell(snapshot.head)}
${applyCheckoutChanges(dir)}`;
}

export async function transferSnapshot(
	alias: string,
	directory: string,
	snapshot: RepositorySnapshot,
	onRetry?: () => void,
): Promise<void> {
	if (!/^cb-[a-z0-9-]+$/.test(alias)) throw new Error("Invalid Cubicle SSH alias.");
	const send = (sshOptions: string[]) =>
		exec(
			"scp",
			[
				...sshOptions,
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=20",
				"-o",
				"ServerAliveInterval=15",
				"-o",
				"ServerAliveCountMax=3",
				snapshot.archive,
				...(snapshot.bundle ? [snapshot.bundle] : []),
				snapshot.replacedPaths,
				`${alias}:${directory}/`,
			],
			{
				timeout: 30 * 60_000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, LC_ALL: "C" },
			},
		);
	try {
		await send([]);
	} catch (error) {
		const { stderr } = error as { stderr?: string };
		if (
			!stderr ||
			/permission denied|host key verification failed|remote host identification has changed/i.test(
				stderr,
			) ||
			!/lost connection|connection (?:reset|closed|timed out)|broken pipe/i.test(stderr)
		)
			throw error;
		onRetry?.();
		// Restoration only starts after all files arrive. Recopy partial files on a new SSH connection.
		await send(["-o", "ControlMaster=no", "-o", "ControlPath=none"]);
	}
}

/** "21 MB", "640 KB": sizes for progress labels, so a slow transfer is visibly a big one. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** "45s", "2m 05s". */
export function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Run one setup step under its own label. A step that outlasts `after` shows a running
 * clock, so a stall says which step it is and for how long, and every step's duration is
 * reported once it ends (failed or not). */
export async function withElapsed<T>(
	report: (label: string) => void,
	label: string,
	run: () => Promise<T>,
	options: { every?: number; after?: number; done?: (label: string, ms: number) => void } = {},
): Promise<T> {
	const { every = 5_000, after = 10_000, done } = options;
	const started = Date.now();
	report(label);
	const tick = setInterval(() => {
		const elapsed = Date.now() - started;
		if (elapsed >= after) report(`${label} (${formatElapsed(elapsed)})`);
	}, every);
	try {
		return await run();
	} finally {
		clearInterval(tick);
		done?.(label, Date.now() - started);
	}
}
