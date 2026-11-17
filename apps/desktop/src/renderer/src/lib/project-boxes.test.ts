import { expect, test } from "bun:test";
import type { Alias, EngineMember } from "@ateam/protocol";
import { projectBoxDestinations } from "./project-boxes";

function checkout(id: string, alias: Alias, sourceProjectId?: string): EngineMember {
	return {
		alias,
		projectId: id,
		project: {
			id,
			sourceProjectId,
			repoPath: "/checkout",
			name: "Demo",
			defaultBranch: "main",
			githubOwner: "team",
			githubName: "demo",
			color: null,
		},
	};
}

test("a Mac project's picker offers only Cubicle Boxes created from that project", () => {
	const source = checkout("mac", null);
	const sandbox = checkout("sandbox", "cb-team-sandbox", source.projectId);
	const members = [
		source,
		checkout("unlinked", "cb-team-sandbox"),
		sandbox,
		checkout("other-sandbox", "cb-team-other", "other-project"),
		checkout("server", "server"),
	];
	const connections = [
		{ alias: "cb-team-sandbox", asleep: true },
		{ alias: "cb-team-other" },
		{ alias: "server" },
		{ alias: "unrelated" },
	];

	expect(projectBoxDestinations(members, connections)).toEqual([
		{ connection: connections[0], member: sandbox, cubicle: true },
	]);
	expect(projectBoxDestinations([checkout("other-project", null)], connections)).toEqual([]);
});

test("a remote-only project can still run on its own engine", () => {
	const member = checkout("server-project", "server");
	const connection = { alias: "server" };
	expect(projectBoxDestinations([member], [connection, { alias: "unrelated" }])).toEqual([
		{ connection, member, cubicle: false },
	]);
});
