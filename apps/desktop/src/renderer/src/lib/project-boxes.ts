import type { EngineMember } from "@ateam/protocol";

export function isCubicleAlias(alias: string | null | undefined): boolean {
	return alias != null && /^cb-[a-z0-9-]+$/.test(alias);
}

/** Offer the project's own sandboxes and the engines that host a remote-only project. */
export function projectBoxDestinations<T extends { alias: string }>(
	members: readonly EngineMember[],
	connections: readonly T[],
): { connection: T; member: EngineMember; cubicle: boolean }[] {
	const localIds = new Set(members.filter((m) => m.alias === null).map((m) => m.projectId));
	const boxes = new Map<string, { member: EngineMember; cubicle: boolean }>();
	for (const member of members) {
		const { alias, project } = member;
		if (alias === null || boxes.has(alias)) continue;
		const fromProject = !!project.sourceProjectId && localIds.has(project.sourceProjectId);
		if (fromProject || localIds.size === 0) {
			boxes.set(alias, { member, cubicle: fromProject || isCubicleAlias(alias) });
		}
	}
	return connections.flatMap((connection) => {
		const box = boxes.get(connection.alias);
		return box ? [{ connection, ...box }] : [];
	});
}
