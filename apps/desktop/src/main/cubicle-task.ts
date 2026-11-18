import { stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgent } from "@ateam/agents";
import { CH, type ProjectDTO, type TaskDTO } from "@ateam/protocol";
import { sshExec } from "@ateam/server";
import {
	CUBICLE_ENVIRONMENT_TASK,
	type CubicleSetupStep,
	type CubicleTaskInput,
	type CubicleTaskResult,
} from "../shared/host";
import type { Backend } from "./backend";
import { CUBICLE_TASK_SCOPE, type Cubicle, freeBoxName } from "./cubicle";
import {
	discardEngineStateCommand,
	environmentBoxName,
	environmentPrompt,
	latestProjectImage,
	type ProjectImages,
	projectIdentity,
	restoreEngineStateCommand,
	taskBoxName,
	WORKSPACE,
} from "./cubicle-project";
import {
	formatBytes,
	formatElapsed,
	initializeWorktreeCommand,
	PROJECT_BASE_REF,
	quoteShell,
	type RepositorySnapshot,
	restoreRepositoryCommand,
	snapshotRepository,
	transferSnapshot,
	withElapsed,
} from "./cubicle-workspace";

type TaskBackend = Pick<Backend, "handle">;

interface CubicleTaskDependencies {
	local: TaskBackend;
	aggregate: TaskBackend;
	cubicle: Cubicle;
	projectImages: Pick<ProjectImages, "during">;
	/** The Ateam image, or undefined when it could not be built (the base image is used). */
	baseImage(): Promise<string | undefined>;
	/** What the Ateam image build is doing, while one runs. */
	baseImageStage?(): string | undefined;
	connect(alias: string): Promise<unknown>;
	configureAgent(alias: string): Promise<void>;
	install(alias: string): Promise<unknown>;
	installAgent(alias: string, agentId: string): Promise<unknown>;
	heldBox(alias: string): TaskBackend;
	/** Drop every trace of a Box that is about to be deleted. */
	forget(alias: string): void;
	progress(step: CubicleSetupStep, stage: string): void;
	onLog(alias: string, chunk: string): void;
	/** Keep a Box whose setup failed, for inspection (ATEAM_CUBICLE_KEEP_FAILED). */
	keepFailed?: boolean;
}

/**
 * Give one worktree its own Box, or open the project's environment Box.
 *
 * A task Box is created from the project image when the project has one: the checkout,
 * its dependencies and the agents' sign-ins are already there, and this Mac only sends
 * the commits and edits made since. Without a project image it starts from the Ateam
 * image and receives the whole repository.
 *
 * Nothing is allocated until Cubicle, its permissions and the private network are known
 * to work, and a Box this call created is removed again when its setup fails: a failure
 * leaves nothing to resume or clean up by hand.
 */
export async function provisionCubicleTask(
	input: CubicleTaskInput,
	deps: CubicleTaskDependencies,
): Promise<CubicleTaskResult> {
	const { local, cubicle, install, installAgent, heldBox, aggregate, progress, onLog } = deps;
	const environment = input.kind === "environment";
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
	const identity = await projectIdentity(source.repoPath);

	// An environment that is open already is simply shown: its checkout is not touched
	// under an agent that may be working in it.
	const openEnvironment = async (): Promise<CubicleTaskResult | undefined> => {
		const alias = cubicle.aliasOfBox(environmentBoxName(identity));
		let backend: TaskBackend;
		try {
			if (!alias) return undefined;
			backend = heldBox(alias);
		} catch {
			return undefined;
		}
		const held = (await backend.handle(CH.projectsList, [])) as ProjectDTO[];
		const project = held.find((p) => p.repoPath.endsWith(`/${WORKSPACE}/repository`));
		if (!project) return undefined;
		const tasks = (await backend.handle(CH.tasksList, [project.id])) as TaskDTO[];
		const task = tasks.find((t) => t.name === CUBICLE_ENVIRONMENT_TASK);
		return task ? { alias, project, task, created: false } : undefined;
	};

	const run = async (): Promise<CubicleTaskResult> => {
		if (environment) {
			const open = await openEnvironment().catch(() => undefined);
			if (open) return open;
		}
		progress("connection", "Checking Cubicle permissions");
		await cubicle.ensurePermissions(CUBICLE_TASK_SCOPE, (stage) => progress("connection", stage));
		// The private network before any Box: a helper that cannot be repaired stops here.
		progress("connection", "Checking the private network");
		await cubicle.tunnel.ensure({
			interactive: true,
			progress: (stage) => progress("connection", stage),
		});

		const sandboxProgress = (stage: string) => progress("sandbox", stage);
		sandboxProgress("Looking for the project image");
		const [snapshots, boxes] = await Promise.all([cubicle.listSnapshots(), cubicle.boxNames()]);
		const projectImage = environment ? undefined : latestProjectImage(snapshots, identity.key);
		const name = environment
			? environmentBoxName(identity)
			: freeBoxName(taskBoxName(input.name), boxes);
		// The environment Box is the one Box that is reused: opening it again continues it.
		const reuse = environment && boxes.includes(name);
		// The first sandbox of an organization builds the Ateam image, which takes minutes:
		// say so, and say what it is doing, instead of appearing to hang.
		const baseImage = async () => {
			const report = () => {
				const stage = deps.baseImageStage?.();
				if (stage) sandboxProgress(`Building the Ateam image (first time only): ${stage}`);
			};
			const timer = setInterval(report, 1000);
			try {
				return await deps.baseImage();
			} finally {
				clearInterval(timer);
			}
		};
		const image = reuse ? undefined : (projectImage?.id ?? (await baseImage()));
		// A Box with the Ateam image has the engine and agents; one from the base image has not.
		const prepared = reuse || image !== undefined;

		// Package while the Box starts, when what the Box already holds is known up front.
		let packaging: Promise<RepositorySnapshot> | undefined;
		if (!reuse) {
			packaging = snapshotRepository(source.repoPath, (detail) => progress("repository", detail), {
				have: projectImage?.head,
			});
			packaging.catch(() => {});
		}
		let snapshot: RepositorySnapshot | undefined;
		let alias: string | undefined;
		let usable = false;
		try {
			sandboxProgress(
				reuse
					? "Starting the project environment"
					: projectImage
						? "Creating a Box from the project image"
						: image
							? "Creating a Box from the Ateam image"
							: "Creating a Box",
			);
			alias = await cubicle.provision(
				{ provider: "cubicle", name, region: "", size: "2", resume: reuse },
				sandboxProgress,
				{ snapshotId: image, disposable: !reuse && !deps.keepFailed },
			);
			const target = alias;
			const capture = async (command: string): Promise<string> => {
				let output = "";
				const result = await sshExec(target, `timeout 1800 bash -lc ${quoteShell(command)}`, {
					sshFlags: ["-o", "ConnectTimeout=20"],
					onData: (chunk) => {
						output += chunk;
						onLog(target, chunk);
					},
				});
				if (result.code !== 0)
					throw new Error(`Sandbox setup exited ${result.code}: ${output.slice(-4000)}`);
				return output;
			};
			const remote = async (command: string) => void (await capture(command));

			// Keep the repository under the guest home so it survives box restarts.
			let home = "";
			const homeResult = await sshExec(target, 'printf "%s" "$HOME"', {
				onData: (chunk) => {
					home += chunk;
				},
			});
			if (homeResult.code !== 0 || !home.startsWith("/") || /[\r\n]/.test(home))
				throw new Error("Could not resolve the sandbox home directory.");
			const workspace = `${home}/${WORKSPACE}`;
			const repository = `${workspace}/repository`;

			if (reuse) {
				await timed("sandbox", "Restoring the environment's engine", () =>
					remote(restoreEngineStateCommand),
				);
				const have = await capture(
					`git -C ${quoteShell(repository)} rev-parse --verify --quiet ${PROJECT_BASE_REF} || true`,
				);
				snapshot = await snapshotRepository(
					source.repoPath,
					(detail) => progress("repository", detail),
					{ have: have.trim() || undefined },
				);
			} else {
				if (projectImage) await remote(discardEngineStateCommand);
				snapshot = await (packaging as Promise<RepositorySnapshot>);
			}
			const sent = snapshot;

			const sizes = await Promise.all(
				[sent.bundle, sent.archive].map((file) => (file ? stat(file).then((s) => s.size) : 0)),
			);
			const payload = formatBytes(sizes.reduce((total, size) => total + size, 0));
			await remote(`umask 077; mkdir -p ${quoteShell(workspace)}`);
			await timed(
				"task",
				sent.bundle
					? `Sending ${payload} of Git history and local changes to the Box`
					: `Sending ${payload} of local changes to the Box`,
				() =>
					transferSnapshot(target, workspace, sent, () =>
						progress("task", "SSH dropped. Retrying the transfer to the same Box"),
					),
			);
			await timed("task", "Updating the repository on the Box", () =>
				remote(restoreRepositoryCommand(workspace, sent)),
			);
			if (prepared) {
				await timed("task", "Connecting to Ateam on the Box", () => deps.connect(target));
			} else {
				await timed("task", "Installing Ateam in the sandbox", () => install(target));
			}
			const backend = heldBox(target);
			const project = (await backend.handle(CH.projectsRegister, [repository])) as ProjectDTO;

			// The environment has one task, its chat. Opening the environment opens that task.
			if (environment) {
				const tasks = (await backend.handle(CH.tasksList, [project.id])) as TaskDTO[];
				const existing = tasks.find((t) => t.name === CUBICLE_ENVIRONMENT_TASK);
				if (existing) {
					usable = true;
					await aggregate.handle(CH.projectsList, []);
					await aggregate.handle(CH.tasksList, [project.id]);
					return { alias: target, project, task: existing, created: false };
				}
			}

			const worktreeStarted = Date.now();
			progress("task", "Creating the task worktree");
			const taskInput = {
				projectId: project.id,
				name: environment ? CUBICLE_ENVIRONMENT_TASK : input.name,
				agentId: input.agentId,
				nameAuto: environment ? false : input.nameAuto,
				baseBranch: sent.head,
			};
			let task: TaskDTO | undefined;
			if (!environment && input.issue) {
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
			const created = task;
			// Seeding copies dependencies and env files from the main checkout. It is
			// asynchronous on the engine and must finish before the Mac's edits are applied.
			const deadline = Date.now() + 15 * 60_000;
			for (;;) {
				const tasks = (await backend.handle(CH.tasksList, [project.id])) as TaskDTO[];
				const current = tasks.find((t) => t.id === created.id);
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
			await timed("task", "Applying your local changes to the task checkout", () =>
				remote(initializeWorktreeCommand(workspace, created.worktreePath, { head: sent.head })),
			);
			const agent = getAgent(input.agentId);
			if (!prepared && agent?.install) {
				await timed("task", `Installing ${agent.label} in the sandbox`, () =>
					installAgent(target, input.agentId),
				);
			}
			await timed("task", "Finishing task setup", () => deps.configureAgent(target));
			if (input.agentId === "opencode")
				await backend.handle(CH.settingsUpdate, [{ engine: { defaultAgentId: "opencode" } }]);
			// The task exists and has the code. From here a failure is the project's own
			// (its hooks), which the agent in the task can fix: it must not cost the Box.
			usable = true;
			const warnings: string[] = [];
			if (!environment) {
				for (const [label, hook] of [
					["initializer", sent.initializer],
					["start command", sent.start],
				] as const) {
					if (!hook?.trim()) continue;
					try {
						await timed("task", `Running the project's ${label}`, () =>
							remote(`set -eu\ncd ${quoteShell(created.worktreePath)}\n${hook}`),
						);
					} catch (error) {
						const why = error instanceof Error ? error.message : String(error);
						warnings.push(`The project's ${label} failed: ${why.slice(-600)}`);
					}
				}
			}
			// Teach the aggregate where both new IDs live before the renderer launches the agent.
			await aggregate.handle(CH.projectsList, []);
			await aggregate.handle(CH.tasksList, [project.id]);
			console.info(`[ateam] Cubicle setup finished in ${formatElapsed(Date.now() - setupStarted)}`);
			return {
				alias: target,
				project,
				task: { ...created, preparing: false },
				created: true,
				...(environment
					? {
							prompt: environmentPrompt({
								project: identity.name,
								repository,
								extra: input.prompt,
							}),
						}
					: {}),
				...(warnings.length ? { warning: warnings.join(" ") } : {}),
			};
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			// `provision` removes what it created when it fails itself. Past that point the
			// Box exists: remove it unless it became usable or is the reused environment.
			if (!alias || usable || reuse) throw error;
			if (deps.keepFailed)
				throw new Error(`${why} Box ${name} was kept for inspection (ATEAM_CUBICLE_KEEP_FAILED).`);
			deps.forget(alias);
			const removed = await cubicle.deleteBox(name).then(
				() => true,
				() => false,
			);
			throw new Error(
				removed
					? `${why} The unfinished Box was removed. Try again.`
					: `${why} Box ${name} could not be removed. Delete it in the Cubicle Dashboard.`,
			);
		} finally {
			await (snapshot ?? (await packaging?.catch(() => undefined)))?.cleanup();
		}
	};

	return environment
		? deps.projectImages.during(identity, "Preparing the project environment", run)
		: run();
}
