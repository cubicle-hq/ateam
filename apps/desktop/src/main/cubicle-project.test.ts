import { expect, test } from "bun:test";
import {
	CUBICLE_BOX_NAME,
	CUBICLE_ENVIRONMENT_BOX,
	isCubicleEnvironmentAlias,
} from "../shared/host";
import type { CubicleBox, CubicleSnapshot } from "./cubicle";
import {
	createProjectImages,
	environmentBoxName,
	environmentPrompt,
	latestProjectImage,
	normalizeOrigin,
	projectImageName,
	projectKey,
	restoreEngineStateCommand,
	setAsideEngineStateCommand,
	taskBoxName,
} from "./cubicle-project";

const project = {
	key: projectKey("git@github.com:Acme/App.git", "/Users/a/app"),
	name: "app",
	origin: "git@github.com:Acme/App.git",
};
const HEAD = "0123456789abcdef0123456789abcdef01234567";

test("one repository is one project however it was cloned", () => {
	expect(normalizeOrigin("git@github.com:Acme/App.git")).toBe("github.com/acme/app");
	expect(normalizeOrigin("https://token@github.com/acme/app/")).toBe("github.com/acme/app");
	expect(projectKey("https://github.com/acme/app", "/elsewhere")).toBe(project.key);
	expect(projectKey("https://github.com/acme/other", "/Users/a/app")).not.toBe(project.key);
	// Without an origin the checkout's path is all there is.
	expect(projectKey("", "/Users/a/app")).not.toBe(projectKey("", "/Users/a/app-2"));
});

test("Box names fit Cubicle and an environment is never mistaken for a task", () => {
	const environment = environmentBoxName({
		key: project.key,
		name: "A very long repository name, with punctuation!",
	});
	expect(environment).toMatch(CUBICLE_BOX_NAME);
	expect(environment).toMatch(CUBICLE_ENVIRONMENT_BOX);
	expect(isCubicleEnvironmentAlias(`cb-my-org-${environment}`)).toBe(true);
	expect(isCubicleEnvironmentAlias("cb-my-org-fix-login")).toBe(false);

	const long = taskBoxName("Fix the login redirect loop that happens after the session expires");
	expect(long).toMatch(CUBICLE_BOX_NAME);
	expect(taskBoxName("!!!")).toBe("task");
	expect(taskBoxName(environment)).not.toMatch(CUBICLE_ENVIRONMENT_BOX);
});

const snapshot = (name: string, createdAt: string, box = "env"): CubicleSnapshot => ({
	id: `id-${name}`,
	name,
	createdAt,
	box: { id: "b", name: box },
});

test("the newest image of this project is the one tasks start from", () => {
	const older = projectImageName(project.key, HEAD, 1000);
	const newer = projectImageName(project.key, `ffff${HEAD.slice(4)}`, 2000);
	const other = projectImageName("aaaaaaaaaaaa", HEAD, 3000);
	const found = latestProjectImage(
		[
			snapshot(newer, "2026-11-18T10:00:00Z"),
			snapshot(older, "2026-11-17T10:00:00Z"),
			snapshot(other, "2026-11-19T10:00:00Z"),
			snapshot("ateam-runtime-abc", "2026-11-20T10:00:00Z"),
		],
		project.key,
	);
	expect(found).toMatchObject({ id: `id-${newer}`, head: "ffff456789ab", box: "env" });
	expect(latestProjectImage([], project.key)).toBeUndefined();
	expect(() => projectImageName(project.key, "not-a-commit")).toThrow();
});

test("the environment brief points the agent at the main checkout", () => {
	const brief = environmentPrompt({
		project: "app",
		repository: "/home/ateam/.ateam-sandboxes/project/repository",
		extra: "We use pnpm 9.",
	});
	expect(brief).toContain("/home/ateam/.ateam-sandboxes/project/repository");
	expect(brief).toContain("Save project image");
	expect(brief).toContain("We use pnpm 9.");
});

function fixture() {
	const calls: string[] = [];
	const snapshots: CubicleSnapshot[] = [];
	let box: CubicleBox | undefined = {
		id: "b1",
		name: environmentBoxName(project),
		state: "running",
		privateIp: "10.0.0.2",
		ssh: { ready: true, reason: null },
	};
	let captureFails = false;
	const images = createProjectImages({
		cubicle: {
			connectionKey: () => "connection",
			status: async () => ({ state: "connected", org: "acme" }),
			listSnapshots: async () => snapshots,
			findBox: async () => box,
			wakeBox: async (alias) => void calls.push(`wake ${alias}`),
			captureImage: async (name, image) => {
				calls.push(`capture ${name}`);
				if (captureFails) throw new Error("No capacity for snapshots");
				snapshots.push(snapshot(image, "2026-11-18T12:00:00Z", name));
				if (box) box = { ...box, state: "stopped" };
				return "snapshot-1";
			},
		},
		remote: async (alias, command) => {
			calls.push(
				command === setAsideEngineStateCommand
					? "set aside"
					: command === restoreEngineStateCommand
						? "restore"
						: `run ${alias}`,
			);
			return `${HEAD}\n`;
		},
		release: (alias) => void calls.push(`release ${alias}`),
		now: () => 5000,
	});
	return {
		images,
		calls,
		failCapture: () => {
			captureFails = true;
		},
		removeBox: () => {
			box = undefined;
		},
	};
}

test("saving lets go of the engine, sets its state aside, then snapshots the stopped Box", async () => {
	const f = fixture();
	const alias = `cb-acme-${environmentBoxName(project)}`;
	expect(await f.images.status(project)).toEqual({
		available: true,
		environment: { box: environmentBoxName(project), alias, state: "running" },
	});
	const stages: string[] = [];
	const saved = await f.images.save(project, alias, "/home/a/repository", (s) => stages.push(s));
	expect(f.calls).toEqual([
		`run ${alias}`,
		`release ${alias}`,
		"set aside",
		`capture ${environmentBoxName(project)}`,
	]);
	expect(saved.image).toEqual({ head: HEAD.slice(0, 12), createdAt: "2026-11-18T12:00:00Z" });
	expect(saved.environment?.state).toBe("stopped");
	expect(saved.activity).toBeUndefined();
	expect(stages.at(-1)).toBe("Stopping the Box and saving its disk");
});

test("a save that fails gives the environment its engine back and says why", async () => {
	const f = fixture();
	f.failCapture();
	const alias = `cb-acme-${environmentBoxName(project)}`;
	await expect(f.images.save(project, alias, "/home/a/repository", () => {})).rejects.toThrow(
		"The project image was not saved: No capacity for snapshots",
	);
	expect(f.calls.slice(-2)).toEqual([`wake ${alias}`, "restore"]);
	const after = await f.images.status(project);
	expect(after.image).toBeUndefined();
	expect(after.error).toContain("No capacity");
	expect(after.activity).toBeUndefined();
});

test("status is read from Cubicle: a deleted environment is simply gone", async () => {
	const f = fixture();
	f.removeBox();
	expect(await f.images.status(project)).toEqual({ available: true });
});

test("only one setup or save runs for a project at a time", async () => {
	const f = fixture();
	let finish: () => void = () => {};
	const running = f.images.during(
		project,
		"Preparing",
		() => new Promise<void>((r) => (finish = r)),
	);
	expect((await f.images.status(project)).activity).toEqual({
		kind: "setup",
		detail: "Preparing",
	});
	await expect(f.images.during(project, "Again", async () => {})).rejects.toThrow("busy");
	await expect(f.images.save(project, "cb-acme-x", "/r", () => {})).rejects.toThrow("busy");
	finish();
	await running;
	expect((await f.images.status(project)).activity).toBeUndefined();
});
