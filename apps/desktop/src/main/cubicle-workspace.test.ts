import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	initializeWorktreeCommand,
	repositoryInitializer,
	restoreRepositoryCommand,
	sandboxName,
	snapshotRepository,
	transferSnapshot,
} from "./cubicle-workspace";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "cubicle-test-"));
	roots.push(root);
	const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
	await git("init", "-b", "main");
	await git("config", "user.name", "Test");
	await git("config", "user.email", "test@example.com");
	await writeFile(join(root, "tracked.txt"), "committed\n");
	await writeFile(join(root, "deleted.txt"), "delete me\n");
	await writeFile(join(root, ".gitignore"), "ignored.txt\n.ateam/worktrees/\n");
	await git("add", "tracked.txt", "deleted.txt", ".gitignore");
	await git("commit", "-m", "test fixture");
	await git("branch", "retained-history");
	await mkdir(join(root, "scripts"));
	await writeFile(
		join(root, "scripts/init.sh"),
		'set -eu\ntest "$(cat tracked.txt)" = dirty\ntest ! -e ignored.txt\ntest ! -e deleted.txt\ngit rev-parse --show-toplevel > initialized.txt\n',
	);
	return { root, git };
}

test("Git history and local changes survive transfer from a linked worktree", async () => {
	const { root, git } = await fixture();
	const source = join(root, ".ateam/worktrees/source");
	await git("worktree", "add", "-b", "source", source);
	await cp(join(root, "scripts"), join(source, "scripts"), { recursive: true });
	await writeFile(join(source, "tracked.txt"), "dirty\n");
	await rm(join(source, "deleted.txt"));
	await writeFile(join(source, "ignored.txt"), "ignored local data");
	await writeFile(join(source, "untracked\nfile.txt"), "untracked");
	await symlink("tracked.txt", join(source, "link"));
	await mkdir(join(source, ".ateam/worktrees/old"), { recursive: true });
	await writeFile(join(source, ".ateam/worktrees/old/sentinel"), "must not copy other tasks");
	const snapshot = await snapshotRepository(source);
	try {
		const dest = join(root, "remote space's");
		await mkdir(dest);
		await cp(snapshot.archive, join(dest, "changes.tar"));
		await cp(snapshot.bundle, join(dest, "repository.bundle"));
		await cp(snapshot.replacedPaths, join(dest, "replaced-paths"));
		await exec("bash", ["-c", restoreRepositoryCommand(dest, snapshot)]);
		const repo = join(dest, "repository");
		expect((await exec("git", ["-C", repo, "rev-parse", "retained-history"])).stdout.trim()).toBe(
			snapshot.head,
		);
		const worktree = join(dest, "task space's");
		await exec("git", ["-C", repo, "worktree", "add", "-b", "task", worktree]);
		await exec("bash", ["-c", initializeWorktreeCommand(dest, worktree, snapshot)]);
		expect((await readFile(join(worktree, "initialized.txt"), "utf8")).trim()).toBe(
			await realpath(worktree),
		);
		expect(await readFile(join(worktree, "untracked\nfile.txt"), "utf8")).toBe("untracked");
		expect(await readFile(join(worktree, "link"), "utf8")).toBe("dirty\n");
		expect(
			await readFile(join(worktree, ".ateam/worktrees/old/sentinel"), "utf8").catch(() => null),
		).toBeNull();
		expect((await exec("git", ["-C", worktree, "rev-parse", "HEAD"])).stdout.trim()).toBe(
			snapshot.head,
		);
		expect((await exec("git", ["-C", repo, "fsck", "--full"])).stderr).not.toContain("error");
		await expect(
			exec("bash", [
				"-c",
				initializeWorktreeCommand(dest, worktree, { ...snapshot, initializer: "exit 42" }),
			]),
		).rejects.toThrow();
	} finally {
		await snapshot.cleanup();
	}
});

test("initializer configuration is optional and invalid commands fail", async () => {
	const { root } = await fixture();
	expect(await repositoryInitializer(root)).toBe("bash 'scripts/init.sh'");
	await mkdir(join(root, ".ateam"));
	await writeFile(
		join(root, ".ateam/sandbox.json"),
		JSON.stringify({ initializer: "npm run setup" }),
	);
	expect(await repositoryInitializer(root)).toBe("npm run setup");
	await writeFile(join(root, ".ateam/sandbox.json"), '{"initializer":""}');
	await expect(repositoryInitializer(root)).rejects.toThrow("initializer");
	await rm(join(root, ".ateam/sandbox.json"));
	await rm(join(root, "scripts/init.sh"));
	const snapshot = await snapshotRepository(root);
	try {
		expect(snapshot.initializer).toBeUndefined();
		const worktree = join(root, ".ateam/worktrees/plain");
		await exec("git", ["-C", root, "worktree", "add", "-b", "plain", worktree]);
		await exec("bash", ["-c", initializeWorktreeCommand(snapshot.directory, worktree, snapshot)]);
		expect(await readFile(join(worktree, "tracked.txt"), "utf8")).toBe("committed\n");

		await writeFile(join(root, ".ateam/sandbox.json"), '{"start":"npm run dev"}');
		expect(await repositoryInitializer(root)).toBeUndefined();
	} finally {
		await snapshot.cleanup();
	}
});

test("box names match worktree branches and skip copied refs", async () => {
	const { root, git } = await fixture();
	expect(await sandboxName(root, "Next.js live browser demo")).toBe("next-js-live-browser-demo");
	await git("branch", "next-js-live-browser-demo");
	expect(await sandboxName(root, "Next.js live browser demo")).toBe("next-js-live-browser-demo-2");
	await expect(sandboxName(root, "x".repeat(41))).rejects.toThrow("1–40");
});

test("retries a dropped SCP transfer once, with a fresh connection to the same Box", async () => {
	const { root } = await fixture();
	const snapshot = await snapshotRepository(root);
	const log = join(root, "scp.log");
	await writeFile(
		join(root, "scp"),
		`#!/bin/sh
printf '%s\\n' "$*" >> "$ATEAM_TEST_SCP_LOG"
case "$*" in
	*ControlPath=none*) exit 0 ;;
esac
echo 'lost connection' >&2
exit 1
`,
		{ mode: 0o700 },
	);
	const path = process.env.PATH;
	process.env.PATH = `${root}:${path}`;
	process.env.ATEAM_TEST_SCP_LOG = log;
	let retries = 0;
	try {
		await transferSnapshot("cb-team-demo", "/home/test", snapshot, () => {
			retries++;
		});
		const calls = (await readFile(log, "utf8")).trim().split("\n");
		expect(retries).toBe(1);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toBe(`-o ControlMaster=no -o ControlPath=none ${calls[0]}`);
		expect(calls[1]).toEndWith("cb-team-demo:/home/test/");
	} finally {
		process.env.PATH = path;
		delete process.env.ATEAM_TEST_SCP_LOG;
		await snapshot.cleanup();
	}
});
