import { expect, test } from "bun:test";
import type { ProjectDTO } from "./index";
import { aliasLabel, unifyProjects } from "./unify";

function project(id: string, over: Partial<ProjectDTO> = {}): ProjectDTO {
	return {
		id,
		repoPath: `/repo/${id}`,
		name: id,
		defaultBranch: "main",
		githubOwner: null,
		githubName: null,
		color: "#fff",
		...over,
	};
}

test("same GitHub repo across engines merges into one card with both members", () => {
	const local = project("pLocal", { name: "ateam", githubOwner: "clawnify", githubName: "ateam" });
	const remote = project("pRemote", {
		name: "ateam",
		githubOwner: "clawnify",
		githubName: "ateam",
	});
	const cards = unifyProjects([local, remote], { pLocal: null, pRemote: "hetzner" });

	expect(cards).toHaveLength(1);
	expect(cards[0]?.key).toBe("gh:clawnify/ateam");
	expect(cards[0]?.members.map((m) => m.alias)).toEqual([null, "hetzner"]); // local first
	expect(cards[0]?.members.map((m) => m.projectId)).toEqual(["pLocal", "pRemote"]);
});

// Two clones of one repo really do disagree on casing: this Mac cloned
// github.com/clawnify/taskwindow, the box cloned github.com/clawnify/TaskWindow.
// GitHub says those are the same repo, so the board must too.
test("owner/name casing doesn't split a repo across engines", () => {
	const local = project("pLocal", { githubOwner: "clawnify", githubName: "taskwindow" });
	const remote = project("pRemote", { githubOwner: "Clawnify", githubName: "TaskWindow" });
	const cards = unifyProjects([local, remote], { pLocal: null, pRemote: "hetzner" });

	expect(cards).toHaveLength(1);
	expect(cards[0]?.key).toBe("gh:clawnify/taskwindow");
	expect(cards[0]?.members.map((m) => m.alias)).toEqual([null, "hetzner"]);
});

test("unlinked projects with the same name stay separate", () => {
	const a = project("pA", { name: "scratch" });
	const b = project("pB", { name: "scratch" }); // same name, no gh identity
	const cards = unifyProjects([a, b], { pA: null, pB: "hetzner" });

	expect(cards).toHaveLength(2);
	expect(cards.every((c) => c.members.length === 1)).toBe(true);
});

test("a Cubicle copy uses its Mac project's card and retains its own routing ID", () => {
	const local = project("mac");
	const copy = project("copy", { sourceProjectId: local.id });
	const origins = { mac: null, copy: "cb-demo" };
	const [joined] = unifyProjects([copy, local], origins);
	expect(joined?.key).toBe("engine:local:mac");
	expect(joined?.name).toBe("mac");
	expect(joined?.members.map((m) => [m.alias, m.projectId])).toEqual([
		[null, "mac"],
		["cb-demo", "copy"],
	]);
	expect(unifyProjects([copy], origins)[0]?.key).toBe("engine:cb-demo:copy");
});

test("a projectId missing from origins defaults to local", () => {
	const cards = unifyProjects([project("pA")], {});
	expect(cards[0]?.members[0]?.alias).toBeNull();
});

test("partial availability: a repo on only one engine is a one-member card", () => {
	const local = project("pLocal", { githubOwner: "o", githubName: "r" });
	const cards = unifyProjects([local], { pLocal: null });
	expect(cards).toHaveLength(1);
	expect(cards[0]?.members).toHaveLength(1);
	expect(cards[0]?.members[0]?.alias).toBeNull();
});

test("aliasLabel renders local as Local and a box as its alias", () => {
	expect(aliasLabel(null)).toBe("Local");
	expect(aliasLabel("hetzner")).toBe("hetzner");
});
