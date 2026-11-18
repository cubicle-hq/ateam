import { expect, test } from "bun:test";
import { openCubicleTunnel, parseCubicleListeners } from "./cubicle-preview";

test("discovers reachable app listeners across both address families", () => {
	const ports = parseCubicleListeners(`engine 1106
IPv4
LISTEN 0 128 0.0.0.0:22 0.0.0.0:*
LISTEN 0 128 127.0.0.1:3000 0.0.0.0:* users:(("next-server",pid=8,fd=5))
LISTEN 0 128 10.0.0.10:8080 0.0.0.0:*
LISTEN 0 128 127.0.0.1:26020 0.0.0.0:* users:(("node",pid=1106,fd=24))
LISTEN 0 128 127.0.0.1:38307 0.0.0.0:* users:(("codex",pid=1660,fd=41))
LISTEN 0 128 127.0.0.1:9222 0.0.0.0:*
IPv6
LISTEN 0 128 *:3000 *:*
LISTEN 0 128 [::]:5173 [::]:*
LISTEN 0 128 [::1]:4000 [::]:*`);
	expect([...ports]).toEqual([
		[3000, "127.0.0.1"],
		[8080, "10.0.0.10"],
		[5173, "::1"],
		[4000, "::1"],
	]);
});

test("the local preview binds an ephemeral loopback port and releases it", async () => {
	const first = await openCubicleTunnel("cb-test", "127.0.0.1", 3000);
	const second = await openCubicleTunnel("cb-test", "::1", 3000);
	try {
		expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(second.url).not.toBe(first.url);
	} finally {
		first.close();
		second.close();
	}
	await expect(fetch(first.url)).rejects.toThrow();
});
