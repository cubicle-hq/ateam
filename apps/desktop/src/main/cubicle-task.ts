import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgent } from "@ateam/agents";
import { CH, type ProjectDTO, type TaskDTO } from "@ateam/protocol";
import { sshExec } from "@ateam/server";
import type { CubicleSetupStep, CubicleTaskInput, CubicleTaskResult } from "../shared/host";
import type { Backend } from "./backend";
import { CUBICLE_TASK_SCOPE, type Cubicle } from "./cubicle";
import {
	formatBytes,
	formatElapsed,
	initializeWorktreeCommand,
	quoteShell,
	restoreRepositoryCommand,
	sandboxName,
	snapshotRepository,
	transferSnapshot,
	withElapsed,
} from "./cubicle-workspace";

type TaskBackend = Pick<Backend, "handle">;

interface CubicleTaskDependencies {
	local: TaskBackend;
	aggregate: TaskBackend;
	cubicle: Cubicle;
	baseImage(): Promise<string | undefined>;
	connect(alias: string): Promise<unknown>;
	configureAgent(alias: string): Promise<void>;
	install(alias: string): Promise<unknown>;
	installAgent(alias: string, agentId: string): Promise<unknown>;
	heldBox(alias: string): TaskBackend;
	progress(step: CubicleSetupStep, stage: string): void;
	onLog(alias: string, chunk: string): void;
}

/** Copy a local checkout into its own box, then prepare the task before launching an agent. */
export async function provisionCubicleTask(
	input: CubicleTaskInput,
	deps: CubicleTaskDependencies,
): Promise<CubicleTaskResult> {
	const { local, cubicle, install, installAgent, heldBox, aggregate, progress, onLog } = deps;
	const setupStarted = Date.now();
	// Each step gets its own label and a running clock, so a slow setup names the slow step.
	const timed = <T>(step: CubicleSetupStep, label: string, run: () => Promise<T>) =>
		withElapsed((stage) => progress(step, stage), label, run, {
			done: (stage, ms) =>
				console.info(`[ateam] Cubicle setup: ${stage} took ${formatElapsed(ms)}`),
		});
	const projects = (await local.handle(CH.projectsList, [])) as ProjectDTO[];
	const source = projects.find((p) => p.id === input.projectId);
	if (!source) throw new Error("Cubicle sandbox creation needs a repository on this Mac.");
	progress("repository", "Checking the local Git repository on your Mac");
	const name = input.resumeBox?.trim() || (await sandboxName(source.repoPath, input.name));
	const snapshot = await snapshotRepository(source.repoPath, (detail) =>
		progress("repository", detail),
	);
	let alias: string | undefined;
	try {
		progress("connection", "Checking Cubicle permissions");
		await cubicle.ensurePermissions(CUBICLE_TASK_SCOPE, (stage) => progress("connection", stage));
		const runRemote = async (target: string, command: string) => {
			let tail = "";
			const result = await sshExec(target, `timeout 1800 bash -lc ${quoteShell(command)}`, {
				sshFlags: ["-o", "ConnectTimeout=20"],
				onData: (chunk) => {
					tail = (tail + chunk).slice(-4000);
					onLog(target, chunk);
				},
			});
			if (result.code !== 0) throw new Error(`Sandbox setup exited ${result.code}: ${tail}`);
		};
		const sandboxProgress = (stage: string) => progress("sandbox", stage);
		let image: string | undefined;
		if (!input.resumeBox) {
			sandboxProgress("Checking the reusable Ateam image");
			image = await deps.baseImage();
		}
		sandboxProgress(
			input.resumeBox
				? "Finding the unfinished Box"
				: image
					? "Cloning the Ateam image"
					: "Creating a Box",
		);
		alias = await cubicle.provision(
			{ provider: "cubicle", name, region: "", size: "2", resume: Boolean(input.resumeBox) },
			sandboxProgress,
			image,
		);
		const target = alias;
		const remote = (command: string) => runRemote(target, command);
		// Keep the repository under the guest home so it survives box restarts.
		let home = "";
		const homeResult = await sshExec(target, 'printf "%s" "$HOME"', {
			onData: (chunk) => {
				home += chunk;
			},
		});
		if (homeResult.code !== 0 || !home.startsWith("/") || /[\r\n]/.test(home))
			throw new Error("Could not resolve the sandbox home directory.");
		const workspace = `${home}/.ateam-sandboxes/${name}`;
		if (input.resumeBox)
			await remote(
				`test ! -e ${quoteShell(`${workspace}/ready`)} || { echo 'This sandbox already completed setup. Create a new sandbox for a new task.'; exit 1; }`,
			);
		const sizes = await Promise.all(
			[snapshot.bundle, snapshot.archive].map((file) => stat(file).then((s) => s.size)),
		);
		const payload = formatBytes(sizes.reduce((total, size) => total + size, 0));
		await remote(`umask 077; mkdir -p ${quoteShell(workspace)}`);
		await timed("task", `Sending ${payload} of Git history and local changes to the Box`, () =>
			transferSnapshot(target, workspace, snapshot, () =>
				progress("task", "SSH dropped. Retrying the transfer to the same Box"),
			),
		);
		await timed("task", "Unpacking the repository on the Box", () =>
			remote(restoreRepositoryCommand(workspace, snapshot)),
		);
		if (image) {
			await timed("task", "Connecting to Ateam on the Box", () => deps.connect(target));
		} else {
			await timed("task", "Installing Ateam in the sandbox", () => install(target));
		}
		const backend = heldBox(target);
		const project = (await backend.handle(CH.projectsRegister, [
			`${workspace}/repository`,
		])) as ProjectDTO;
		const worktreeStarted = Date.now();
		progress("task", "Creating the task worktree");
		const taskInput = {
			projectId: project.id,
			name: input.name,
			agentId: input.agentId,
			nameAuto: input.nameAuto,
			baseBranch: snapshot.head,
		};
		const existingTasks = input.resumeBox
			? ((await backend.handle(CH.tasksList, [project.id])) as TaskDTO[])
			: [];
		const existingTask = existingTasks.find((t) => t.name === input.name);
		if (existingTasks.length && !existingTask)
			throw new Error("Resume with the original task name, or create a new sandbox.");
		if (
			existingTask &&
			((await backend.handle(CH.ptyListForTask, [existingTask.id])) as unknown[]).length
		)
			throw new Error(
				"This sandbox has agent sessions. Inspect it before retrying initialization.",
			);
		let task = existingTask;
		if (!task && input.issue) {
			const result = (await backend.handle(CH.tasksCreateFromIssue, [
				{
					...taskInput,
					issueNumber: input.issue.number,
					description: input.issue.description,
				},
			])) as { task: TaskDTO };
			task = result.task;
		}
		task ??= (await backend.handle(CH.tasksCreate, [taskInput])) as TaskDTO;
		// Seeding is asynchronous on the engine. It must finish before replacing the checkout.
		const deadline = Date.now() + 15 * 60_000;
		for (;;) {
			const tasks = (await backend.handle(CH.tasksList, [project.id])) as TaskDTO[];
			const current = tasks.find((t) => t.id === task.id);
			if (!current) throw new Error("The sandbox task was removed during setup.");
			if (!current.preparing) break;
			if (Date.now() >= deadline) throw new Error("Timed out preparing the sandbox worktree.");
			const waited = Date.now() - worktreeStarted;
			if (waited >= 10_000)
				progress("task", `Creating the task worktree (${formatElapsed(waited)})`);
			await sleep(1000);
		}
		console.info(
			`[ateam] Cubicle setup: Creating the task worktree took ${formatElapsed(Date.now() - worktreeStarted)}`,
		);
		await timed(
			"task",
			snapshot.initializer
				? "Restoring and initializing the task checkout"
				: "Restoring the task checkout",
			() => remote(initializeWorktreeCommand(workspace, task.worktreePath, snapshot)),
		);
		if (snapshot.start?.trim()) {
			const start = snapshot.start;
			await timed("task", "Starting the application", () =>
				remote(`set -eu\ncd ${quoteShell(task.worktreePath)}\n${start}`),
			);
		}
		const agent = getAgent(input.agentId);
		if (!image && agent?.install) {
			await timed("task", `Installing ${agent.label} in the sandbox`, () =>
				installAgent(target, input.agentId),
			);
		}
		await timed("task", "Finishing task setup", () => deps.configureAgent(target));
		if (input.agentId === "opencode")
			await backend.handle(CH.settingsUpdate, [{ engine: { defaultAgentId: "opencode" } }]);
		await remote(`printf "%s\\n" ${quoteShell(task.id)} > ${quoteShell(`${workspace}/ready`)}`);
		// Teach the aggregate where both new IDs live before the renderer launches the agent.
		await aggregate.handle(CH.projectsList, []);
		await aggregate.handle(CH.tasksList, [project.id]);
		console.info(`[ateam] Cubicle setup finished in ${formatElapsed(Date.now() - setupStarted)}`);
		return { alias: target, project, task: { ...task, preparing: false } };
	} catch (error) {
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}${alias ? ` Box ${alias} and its files were retained. Resume unfinished sandbox with box name ${name}.` : ` Provisioning name: ${name}.`}`,
		);
	} finally {
		await snapshot.cleanup();
	}
}
