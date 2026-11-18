import { expect, test } from "bun:test";
import { createCubicleImageCache } from "./cubicle-gold";

function fixture() {
	const calls: string[] = [];
	let key = "first organization";
	const snapshots = new Map<string, string>();
	let installFails = false;
	const boxes = ["gold-runtime-current", "gold-runtime-older", "someone-elses-box"];
	const cubicle = {
		connectionKey: () => key,
		listSnapshots: async () =>
			[...snapshots]
				.filter(([name]) => name.startsWith(key))
				.map(([name, id]) => ({
					id,
					name: name.slice(key.length),
					createdAt: "2026-11-18T00:00:00.000Z",
					box: { id: "b", name: "gold-runtime-current" },
				})),
		boxNames: async () => boxes,
		provision: async () => {
			calls.push("provision");
			return "cb-test-gold";
		},
		captureImage: async (_builder: string, name: string) => {
			calls.push("capture");
			const id = `snapshot-${snapshots.size + 1}`;
			snapshots.set(key + name, id);
			return id;
		},
		deleteBox: async (name: string) => {
			calls.push(`delete ${name}`);
		},
	};
	const deps = {
		cubicle,
		runtimeVersion: "1",
		installWallpaper: "install wallpaper",
		installEngine: async () => {
			calls.push("engine");
			if (installFails) throw new Error("Install failed");
		},
		remote: async (_alias: string, command: string) => {
			calls.push(command);
		},
	};
	return {
		deps,
		calls,
		setKey: (value: string) => {
			key = value;
		},
		failInstall: (value: boolean) => {
			installFails = value;
		},
	};
}

test("connection and task launches join one reusable build and a later connection finds its snapshot", async () => {
	const f = fixture();
	const cache = createCubicleImageCache(f.deps);
	const warming = cache.prepare();
	expect(cache.status()).toMatchObject({ state: "building", step: "box" });
	expect(cache.prepare()).toBe(warming);
	expect(await warming).toBe("snapshot-1");
	expect(cache.status()).toEqual({ state: "ready" });
	expect(f.calls.filter((s) => s === "provision")).toEqual(["provision"]);
	expect(f.calls.filter((s) => s === "engine")).toEqual(["engine"]);
	expect(f.calls).toContain("install wallpaper");
	expect(f.calls.some((s) => s.includes('rm -rf -- "$HOME/.ateam"'))).toBe(true);
	expect(f.calls.filter((s) => s === "capture")).toEqual(["capture"]);
	// Builders of earlier releases are removed; other Boxes are never touched.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.calls.some((s) => s === "delete someone-elses-box")).toBe(false);
	expect(f.calls.some((s) => s === "delete gold-runtime-older")).toBe(true);

	const restarted = createCubicleImageCache(f.deps);
	const built = () => f.calls.filter((s) => s === "provision" || s === "capture").length;
	const count = built();
	const before = f.calls.length;
	expect(await restarted.prepare()).toBe("snapshot-1");
	expect(built()).toBe(count);
	// A found image keeps the Box it was taken from: the snapshot lives only as long as it.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(f.calls.slice(before)).not.toContain("delete gold-runtime-current");
	expect(f.calls.slice(before)).toContain("delete gold-runtime-older");

	f.setKey("second organization");
	expect(cache.status()).toBeUndefined();
	expect(await cache.prepare()).toBe("snapshot-2");
});

test("a failed image leaves the connection usable, removes the builder, and can be retried", async () => {
	const f = fixture();
	f.failInstall(true);
	const cache = createCubicleImageCache(f.deps);
	expect(await cache.prepare()).toBeUndefined();
	expect(cache.status()).toMatchObject({
		state: "failed",
		message: expect.stringContaining("Install failed"),
	});
	const shape = () => f.calls.map((s) => s.replace(/gold-runtime-.*/, "builder"));
	expect(shape()).toEqual(["provision", "engine", "delete builder"]);
	expect(await cache.prepare()).toBeUndefined();
	expect(shape()).toEqual(["provision", "engine", "delete builder"]);
	f.failInstall(false);
	expect(await cache.prepare(true)).toBe("snapshot-1");
});
