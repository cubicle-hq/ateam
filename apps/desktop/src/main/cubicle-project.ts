// The project image: the middle of the Cubicle lifecycle.
//
//   Ateam image    (cubicle-gold.ts)  engine, agents, desktop. Built once per release.
//   Project image  (this file)        the Ateam image plus one project made ready to work
//                                     on. Built in the project's environment Box by an
//                                     agent, in a chat, and saved when the person says so.
//   Task Box       (cubicle-task.ts)  one per worktree, created from the project image.
//
// Cubicle is the record: a project image is a snapshot whose name carries the project
// and the commit it holds, and the environment Box has a name derived from the project.
// Nothing here is cached on disk, so a Box or snapshot removed in the Dashboard, or a
// second Mac, cannot leave this Mac believing in an image that is gone.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { slugify } from "@ateam/git-core";
import {
	CUBICLE_ENVIRONMENT_BOX,
	CUBICLE_ENVIRONMENT_TASK,
	type CubicleProjectStatus,
} from "../shared/host";
import type { Cubicle, CubicleSnapshot } from "./cubicle";
import { PROJECT_BASE_REF, quoteShell } from "./cubicle-workspace";

const exec = promisify(execFile);

/** Under the guest home, the same in the environment Box and every Box made from it. */
export const WORKSPACE = ".ateam-sandboxes/project";

export interface ProjectIdentity {
	/** Stable for one repository wherever it is checked out: its origin, else its path. */
	key: string;
	name: string;
	origin: string;
}

/** `git@github.com:Acme/App.git` and `https://github.com/acme/app` are one project. */
export function normalizeOrigin(origin: string): string {
	return origin
		.trim()
		.replace(/^[a-z+]+:\/\/(?:[^@/]*@)?/i, "")
		.replace(/^[^@/]+@/, "")
		.replace(":", "/")
		.replace(/\.git\/?$/i, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

export function projectKey(origin: string, repoPath: string): string {
	return createHash("sha256")
		.update(origin.trim() ? `origin\n${normalizeOrigin(origin)}` : `path\n${repoPath}`)
		.digest("hex")
		.slice(0, 12);
}

export async function projectIdentity(root: string): Promise<ProjectIdentity> {
	const repoPath = await realpath(root);
	const origin = await exec("git", ["-C", repoPath, "remote", "get-url", "origin"]).then(
		({ stdout }) => stdout.trim(),
		() => "",
	);
	const name = origin ? basename(normalizeOrigin(origin)) : basename(repoPath);
	return { key: projectKey(origin, repoPath), name, origin };
}

/** `ateam-env-<project>-<key>`: one environment Box per project and organization. */
export function environmentBoxName(project: Pick<ProjectIdentity, "key" | "name">): string {
	const slug = slugify(project.name).slice(0, 21).replace(/-+$/, "") || "project";
	return `ateam-env-${slug}-${project.key.slice(0, 8)}`;
}

/** A task's Box: its name, shortened to what Cubicle accepts, never the environment's. */
export function taskBoxName(taskName: string): string {
	const slug = slugify(taskName).slice(0, 40).replace(/-+$/, "") || "task";
	return CUBICLE_ENVIRONMENT_BOX.test(slug) ? `task-${slug}`.slice(0, 40) : slug;
}

const IMAGE_NAME = /^ateam-project\.([0-9a-f]{12})\.([0-9a-f]{12})\.([0-9a-z]+)$/;

/** The snapshot name is the record: which project, and the commit the Box holds. */
export function projectImageName(key: string, head: string, now = Date.now()): string {
	if (!/^[0-9a-f]{12}$/.test(key) || !/^[0-9a-f]{12,}$/.test(head))
		throw new Error("A project image needs a project and a commit.");
	return `ateam-project.${key}.${head.slice(0, 12)}.${now.toString(36)}`;
}

export interface ProjectImage {
	id: string;
	/** The commit (abbreviated) whose history the image holds in full. */
	head: string;
	createdAt: string;
	box: string;
}

/** The newest image saved for this project, if its environment Box still exists. */
export function latestProjectImage(
	snapshots: readonly CubicleSnapshot[],
	key: string,
): ProjectImage | undefined {
	let latest: ProjectImage | undefined;
	for (const snapshot of snapshots) {
		const match = IMAGE_NAME.exec(snapshot.name);
		if (!match || match[1] !== key) continue;
		if (!latest || Date.parse(snapshot.createdAt) > Date.parse(latest.createdAt))
			latest = {
				id: snapshot.id,
				head: match[2] as string,
				createdAt: snapshot.createdAt,
				box: snapshot.box.name,
			};
	}
	return latest;
}

/**
 * The engine's own state (its database, pairing, this chat) belongs to the environment
 * Box, not to the image: a Box made from the image must start as a new engine, or every
 * task Box would answer with the environment's project and task ids. So the state steps
 * aside for the snapshot and comes back when the environment Box is next used. Agent
 * sign-ins, GitHub access, toolchains and the checkout stay: they are the image.
 */
export const setAsideEngineStateCommand = `set -eu
sudo -n systemctl stop ateam.service
if [ -d "$HOME/.ateam" ]; then
  rm -rf -- "$HOME/.ateam-environment"
  mv -- "$HOME/.ateam" "$HOME/.ateam-environment"
fi
sync`;

/** In the environment Box, after a start: the engine continues where the chat left off. */
export const restoreEngineStateCommand = `set -eu
if [ -d "$HOME/.ateam-environment" ]; then
  sudo -n systemctl stop ateam.service || true
  rm -rf -- "$HOME/.ateam"
  mv -- "$HOME/.ateam-environment" "$HOME/.ateam"
fi
sudo -n systemctl start ateam.service`;

/** In a Box made from the image: the environment's engine state is not this Box's. */
export const discardEngineStateCommand = `rm -rf -- "$HOME/.ateam-environment"`;

/** Prints the commit the image may promise: the last one this Mac sent. */
export const imageHeadCommand = (repository: string) => `set -eu
cd ${quoteShell(repository)}
git rev-parse --verify --quiet ${PROJECT_BASE_REF} || git rev-parse HEAD`;

/** What the agent in the environment chat is asked to do. */
export function environmentPrompt(input: {
	project: string;
	repository: string;
	extra?: string;
}): string {
	return `You are preparing the development environment for "${input.project}" on this machine.

This machine is the project's environment Box. When you are done, Ateam saves its disk as the project image, and every new task for this project starts in a fresh machine copied from it. Whatever you install here is there from the first second of every task. Whatever you skip, every task pays for again.

The main checkout is at ${input.repository}. Work there, not in this task's worktree: Ateam copies installed dependencies and env files from the main checkout into each new task worktree.

Do this:
1. Read the README, contributing notes, CI workflows, lockfiles and tool-version files to learn what the project needs.
2. Install system packages, language toolchains at the versions the project pins, and services it needs (databases, queues). Install them system-wide with sudo, not under a version manager that only works in an interactive shell.
3. In ${input.repository}, install dependencies and run the build steps a developer runs once after cloning. Warm the caches (package manager, compiler, test runner).
4. Prove it works: run the type check, the linter and a fast part of the test suite, and start the dev server once if there is one. Fix what you can; write down what you could not.
5. If the project needs secrets or env files to run, do not invent values. Create the files with placeholders in ${input.repository} and list what a person must fill in.
6. If each task needs a command after its worktree is created (for example a quick dependency sync), or a command to start the app, propose a \`.ateam/sandbox.json\` with \`initializer\` and \`start\` and show it. Do not commit it.

Do not store long-lived personal credentials beyond what the tools need to work here, and leave no half-finished background jobs running.

Finish with a short report: what is installed, what you verified and how, what is missing, and anything a person has to do. Then stop. The person reviews it and selects "Save project image" in this task's toolbar.${
		input.extra?.trim() ? `\n\nFrom the person who started this:\n${input.extra.trim()}` : ""
	}`;
}

interface ProjectImageDependencies {
	cubicle: Pick<
		Cubicle,
		"connectionKey" | "listSnapshots" | "findBox" | "captureImage" | "wakeBox"
	> & { status(): Promise<{ state: string; org?: string }> };
	/** Run a command on a Box over SSH and return what it printed. */
	remote(alias: string, command: string): Promise<string>;
	/** Let go of the Box's engine before it stops, without scheduling a reconnect. */
	release(alias: string): void;
	now?(): number;
}

export function createProjectImages(deps: ProjectImageDependencies) {
	const { cubicle } = deps;
	// What is happening now, and what went wrong last, per connection and project.
	const activity = new Map<string, NonNullable<CubicleProjectStatus["activity"]>>();
	const errors = new Map<string, string>();
	const slot = (key: string) => `${cubicle.connectionKey()}\n${key}`;

	async function status(project: ProjectIdentity): Promise<CubicleProjectStatus> {
		const connection = await cubicle.status();
		if (connection.state !== "connected" || !connection.org || !cubicle.connectionKey())
			return { available: false };
		const box = environmentBoxName(project);
		const [snapshots, environment] = await Promise.all([
			cubicle.listSnapshots(),
			cubicle.findBox(box),
		]);
		const image = latestProjectImage(snapshots, project.key);
		const id = slot(project.key);
		return {
			available: true,
			...(image ? { image: { head: image.head, createdAt: image.createdAt } } : {}),
			...(environment
				? {
						environment: {
							box,
							alias: `cb-${connection.org}-${box}`,
							state: environment.state,
						},
					}
				: {}),
			...(activity.has(id) ? { activity: activity.get(id) } : {}),
			...(errors.has(id) ? { error: errors.get(id) } : {}),
		};
	}

	/** Mark setup as running for status readers while `run` provisions the environment. */
	async function during<T>(project: ProjectIdentity, detail: string, run: () => Promise<T>) {
		const id = slot(project.key);
		if (activity.has(id)) throw new Error("This project's environment is busy. Try again shortly.");
		activity.set(id, { kind: "setup", detail });
		errors.delete(id);
		try {
			return await run();
		} catch (error) {
			errors.set(id, error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			activity.delete(id);
		}
	}

	/**
	 * Save the environment Box's disk as the project image. The Box stops for the
	 * snapshot and stays stopped; opening its chat again starts it.
	 */
	async function save(
		project: ProjectIdentity,
		alias: string,
		repository: string,
		progress: (detail: string) => void,
	): Promise<CubicleProjectStatus> {
		const id = slot(project.key);
		if (activity.has(id)) throw new Error("This project's environment is busy. Try again shortly.");
		const report = (detail: string) => {
			activity.set(id, { kind: "saving", detail });
			progress(detail);
		};
		report("Checking the environment");
		errors.delete(id);
		const box = environmentBoxName(project);
		let setAside = false;
		try {
			const head = (await deps.remote(alias, imageHeadCommand(repository))).trim();
			if (!/^[0-9a-f]{40,}$/.test(head))
				throw new Error("The environment's checkout has no commit to save.");
			report("Stopping agents and the engine");
			deps.release(alias);
			await deps.remote(alias, setAsideEngineStateCommand);
			setAside = true;
			report("Stopping the Box and saving its disk");
			await cubicle.captureImage(box, projectImageName(project.key, head, deps.now?.()));
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			errors.set(id, why);
			// Leave the environment as it was: running, with its engine and chat back.
			if (setAside) {
				await cubicle
					.wakeBox(alias)
					.then(() => deps.remote(alias, restoreEngineStateCommand))
					.catch(() => {});
			}
			throw new Error(`The project image was not saved: ${why}`);
		} finally {
			activity.delete(id);
		}
		return status(project);
	}

	return { status, during, save };
}

export type ProjectImages = ReturnType<typeof createProjectImages>;
export { CUBICLE_ENVIRONMENT_TASK };
