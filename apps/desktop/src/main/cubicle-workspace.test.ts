import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	initializeWorktreeCommand,
	PROJECT_BASE_REF,
	repositoryInitializer,
	restoreRepositoryCommand,
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
		await cp(snapshot.bundle as string, join(dest, "repository.bundle"));
		await cp(snapshot.replacedPaths, join(dest, "replaced-paths"));
		await exec("bash", ["-c", restoreRepositoryCommand(dest, snapshot)]);
		const repo = join(dest, "repository");
		expect((await exec("git", ["-C", repo, "rev-parse", "retained-history"])).stdout.trim()).toBe(
			snapshot.head,
		);
		const worktree = join(dest, "task space's");
		await exec("git", ["-C", repo, "worktree", "add", "-b", "task", worktree]);
		await exec("bash", ["-c", initializeWorktreeCommand(dest, worktree, snapshot)]);
		// The project's own hook runs after the checkout is in place, as its own step.
		await exec("bash", [
			"-c",
			`set -eu\ncd '${worktree.replace(/'/g, "'\\''")}'\n${snapshot.initializer}`,
		]);
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

test("a Box made from the project image receives only what changed and keeps its setup", async () => {
	const { root, git } = await fixture();
	const first = await snapshotRepository(root);
	const dest = join(root, "..", `${root.split("/").pop()}-box`);
	roots.push(dest);
	await mkdir(dest);
	const repo = join(dest, "repository");
	const send = async (snapshot: typeof first) => {
		await cp(snapshot.archive, join(dest, "changes.tar"));
		if (snapshot.bundle) await cp(snapshot.bundle, join(dest, "repository.bundle"));
		await cp(snapshot.replacedPaths, join(dest, "replaced-paths"));
		await exec("bash", ["-c", restoreRepositoryCommand(dest, snapshot)]);
	};
	try {
		// The environment Box: the whole repository, then what project setup leaves behind.
		await send(first);
		await mkdir(join(repo, "node_modules"));
		await writeFile(join(repo, "node_modules/dep.js"), "installed");
		await writeFile(join(repo, ".env"), "SECRET=1");
		await exec("git", ["-C", repo, "config", "core.excludesFile", "/dev/null"]);
		const base = (await exec("git", ["-C", repo, "rev-parse", PROJECT_BASE_REF])).stdout.trim();
		expect(base).toBe(first.head);
	} finally {
		await first.cleanup();
	}

	// Nothing new on the Mac: no history travels at all.
	const same = await snapshotRepository(root, undefined, { have: first.head.slice(0, 12) });
	try {
		expect(same.bundle).toBeUndefined();
		await send(same);
	} finally {
		await same.cleanup();
	}

	// A new commit and an uncommitted edit: only the commit since the image is bundled.
	await writeFile(join(root, "tracked.txt"), "second\n");
	await git("commit", "-am", "second");
	await writeFile(join(root, "tracked.txt"), "dirty\n");
	const full = await snapshotRepository(root);
	const delta = await snapshotRepository(root, undefined, { have: first.head.slice(0, 12) });
	try {
		const listed = (bundle?: string) =>
			exec("git", ["-C", root, "bundle", "list-heads", bundle as string]).then((r) => r.stdout);
		expect(await listed(delta.bundle)).toContain(delta.head);
		expect(await listed(delta.bundle)).not.toContain("retained-history");
		expect(await listed(full.bundle)).toContain("retained-history");
		await send(delta);
		expect((await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim()).toBe(delta.head);
		expect((await exec("git", ["-C", repo, "rev-parse", PROJECT_BASE_REF])).stdout.trim()).toBe(
			delta.head,
		);
		// Setup survives in the main checkout, which is what worktrees are seeded from.
		expect(await readFile(join(repo, "node_modules/dep.js"), "utf8")).toBe("installed");
		expect(await readFile(join(repo, ".env"), "utf8")).toBe("SECRET=1");
		expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("second\n");

		// The task's worktree keeps what the engine seeded and gets the Mac's edit on top.
		const worktree = join(dest, "task");
		await exec("git", ["-C", repo, "worktree", "add", "-b", "task", worktree, delta.head]);
		await mkdir(join(worktree, "node_modules"));
		await writeFile(join(worktree, "node_modules/dep.js"), "seeded");
		await exec("bash", ["-c", initializeWorktreeCommand(dest, worktree, delta)]);
		expect(await readFile(join(worktree, "node_modules/dep.js"), "utf8")).toBe("seeded");
		expect(await readFile(join(worktree, "tracked.txt"), "utf8")).toBe("dirty\n");
	} finally {
		await full.cleanup();
		await delta.cleanup();
	}

	// An image whose commit this Mac does not have: fall back to sending everything.
	const unknown = await snapshotRepository(root, undefined, { have: "0123456789ab" });
	try {
		expect(unknown.bundle).toBeDefined();
	} finally {
		await unknown.cleanup();
	}
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
