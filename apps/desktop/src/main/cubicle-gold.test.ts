import { expect, test } from "bun:test";
import { createCubicleImageCache } from "./cubicle-gold";

function fixture() {
	const calls: string[] = [];
	let key = "first organization";
	const snapshots = new Map<string, string>();
	let installFails = false;
	const cubicle = {
		connectionKey: () => key,
		findGoldImage: async (name: string) => snapshots.get(key + name),
		provision: async () => {
			calls.push("provision");
			return "cb-test-gold";
		},
		captureGoldImage: async (_builder: string, name: string) => {
			calls.push("capture");
			const id = `snapshot-${snapshots.size + 1}`;
			snapshots.set(key + name, id);
			return id;
		},
		stopImageBuilder: async () => {
			calls.push("stop");
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
	expect(f.calls.at(-1)).toBe("capture");

	const restarted = createCubicleImageCache(f.deps);
	const count = f.calls.length;
	expect(await restarted.prepare()).toBe("snapshot-1");
	expect(f.calls).toHaveLength(count);

	f.setKey("second organization");
	expect(cache.status()).toBeUndefined();
	expect(await cache.prepare()).toBe("snapshot-2");
});

test("a failed image leaves the connection usable, stops the builder, and can be retried", async () => {
	const f = fixture();
	f.failInstall(true);
	const cache = createCubicleImageCache(f.deps);
	expect(await cache.prepare()).toBeUndefined();
	expect(cache.status()).toMatchObject({
		state: "failed",
		message: expect.stringContaining("Install failed"),
	});
	expect(f.calls).toEqual(["provision", "engine", "stop"]);
	expect(await cache.prepare()).toBeUndefined();
	expect(f.calls).toEqual(["provision", "engine", "stop"]);
	f.failInstall(false);
	expect(await cache.prepare(true)).toBe("snapshot-1");
});
