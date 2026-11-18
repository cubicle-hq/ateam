import { describe, expect, test } from "bun:test";
import type { ProviderSecrets } from "./box-setup";
import {
	CubicleApiError,
	createCubicle,
	credentialState,
	cubicleApi,
	cubicleError,
	cubicleSshConfig,
	freeBoxName,
	provisioningFailure,
	quoteCubicleIdentity,
	reconnectReason,
	removeCubicleSshConfig,
	validateCubicleSpec,
} from "./cubicle";
import { CubicleTunnelError, type Tunnel } from "./cubicle-tunnel";

describe("Cubicle creation", () => {
	test("rejects unsafe names and unsupported resources before provisioning", () => {
		for (const name of ["--help", "x\nHost *", "foo/bar", "", "a".repeat(41)]) {
			expect(() => validateCubicleSpec({ name, size: "2" }, "dries")).toThrow();
		}
		expect(() => validateCubicleSpec({ name: "demo", size: "2" }, "--help")).toThrow();
		expect(() => validateCubicleSpec({ name: "demo", size: "999" }, "dries")).toThrow();
		expect(() => validateCubicleSpec({ name: "pr-123", size: "4" }, "dries")).not.toThrow();
	});
	test("keeps trusted CLI settings and other hosts, migrates legacy IP entries to internal DNS on resume", () => {
		const original = "Include ~/.ssh/cubicle_config\nHost work\n  HostName work.example\n";
		const once = cubicleSshConfig(original, "dries/demo", "cb-dries-demo", "10.20.30.4");
		expect(once.endsWith(original)).toBe(true);
		expect(once).toContain("ControlMaster auto");
		expect(once).toContain("ControlPath ~/.ssh/ateam-%C");
		expect(once.indexOf("HostName 10.20.30.4")).toBeLessThan(once.indexOf("Include"));
		expect(cubicleSshConfig(once, "dries/demo", "cb-dries-demo", "10.20.30.4")).toBe(once);
		const moved = cubicleSshConfig(
			once,
			"dries/demo",
			"cb-dries-demo",
			"demo.dries.cubicle.internal",
		);
		expect(moved).toContain("HostName demo.dries.cubicle.internal");
		expect(moved).not.toContain("10.20.30.4");
		expect(moved.endsWith(original)).toBe(true);
	});
	test("refuses to overwrite an app entry edited by the user", () => {
		expect(() =>
			cubicleSshConfig(
				"# Ateam Cubicle dries/demo\nHost cb-dries-demo\n",
				"dries/demo",
				"cb-dries-demo",
				"10.20.30.4",
			),
		).toThrow();
	});
});

test("quotes macOS identity paths without changing other keys", () => {
	const path = "/Users/test/Library/Application Support/Ateam/key";
	const original = `Host demo\n    IdentityFile ${path}\nHost other\n    IdentityFile ~/.ssh/id_ed25519\n`;
	const quoted = quoteCubicleIdentity(original, path);
	expect(quoted).toContain(`IdentityFile "${path}"`);
	expect(quoted).toContain("IdentityFile ~/.ssh/id_ed25519");
	expect(quoteCubicleIdentity(quoted, path)).toBe(quoted);
});

const connection = {
	id: "c1",
	applicationId: "ateam",
	org: { id: "o1", name: "acme" },
	permissions: ["boxes:read", "boxes:create"],
};
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function harness(
	replies: ((url: string, init: RequestInit) => Response)[],
	onConnected?: (saved: ProviderSecrets) => void,
	tunnel?: Tunnel,
) {
	let saved: ProviderSecrets = {};
	const calls: { url: string; init: RequestInit }[] = [];
	const opened: string[] = [];
	const cubicle = createCubicle({
		load: () => saved,
		save: (patch) => {
			saved = { ...saved, ...patch };
			if (!saved.cubicle) delete saved.cubicle;
		},
		openExternal: async (url) => void opened.push(url),
		onConnected: () => onConnected?.(saved),
		userData: "/nonexistent",
		tunnel,
		sleep: async () => {},
		fetch: (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			const next = replies.shift();
			if (!next) throw new Error(`unexpected call ${url}`);
			return next(url, init);
		}) as unknown as typeof fetch,
	});
	return { cubicle, calls, opened, saved: () => saved };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("Connect Cubicle", () => {
	test("approves in the browser, then stores Ateam's own key and never shows it", async () => {
		const approvals: (string | undefined)[] = [];
		const h = harness(
			[
				() =>
					json(200, {
						deviceCode: "dc",
						userCode: "ABCD-EFGH",
						verificationUriComplete: "https://dash/device?user_code=ABCD-EFGH",
						interval: 2,
						expiresIn: 600,
					}),
				() => json(400, { error: { code: "authorization_pending", message: "" } }),
				(_u, init) => {
					expect(JSON.parse(String(init.body))).toEqual({ deviceCode: "dc" });
					return json(200, {
						token: "cbk_secret",
						tokenType: "api_key",
						expiresAt: "2099-01-01T00:00:00Z",
						connection,
					});
				},
				(_u, init) => {
					expect((init.headers as Record<string, string>).authorization).toBe("Bearer cbk_secret");
					return json(200, {
						identity: "acme/ateam-1a2b3c",
						orgs: [{ name: "acme", boxCreateAllowed: true }],
					});
				},
			],
			(saved) => {
				approvals.push(saved.cubicle?.connection.org.name);
			},
		);
		const waiting = await h.cubicle.connect();
		expect(waiting).toMatchObject({ state: "waiting", userCode: "ABCD-EFGH" });
		expect(h.opened).toEqual(["https://dash/device?user_code=ABCD-EFGH"]);
		expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ clientId: "ateam" });
		expect(approvals).toEqual([]);
		await settle();
		// The main process can begin image setup before a status poll from the form.
		expect(approvals).toEqual(["acme"]);
		const connected = await h.cubicle.status();
		expect(connected).toMatchObject({
			state: "connected",
			org: "acme",
			identity: "acme/ateam-1a2b3c",
			boxCreateAllowed: true,
		});
		expect(JSON.stringify(connected)).not.toContain("cbk_secret");
		expect(h.saved().cubicle?.token).toBe("cbk_secret");
		expect(h.saved().cubicle?.api).toBe(cubicleApi());
	});

	test("a cancel in the browser leaves Ateam not connected", async () => {
		const h = harness([
			() =>
				json(200, {
					deviceCode: "dc",
					userCode: "X",
					verificationUriComplete: "u",
					interval: 1,
					expiresIn: 600,
				}),
			() => json(400, { error: { code: "access_denied", message: "" } }),
		]);
		await h.cubicle.connect();
		await settle();
		const s = await h.cubicle.status();
		expect(s.state).toBe("disconnected");
		expect(s.message).toContain("cancelled");
		expect(h.saved().cubicle).toBeUndefined();
	});

	test("a key revoked in the Dashboard flips to reconnect and is deleted", async () => {
		const h = harness([
			() => json(401, { error: { code: "connection_revoked", message: "revoked" } }),
		]);
		const store = h.saved();
		store.cubicle = {
			api: cubicleApi(),
			token: "cbk_old",
			expiresAt: "2099-01-01T00:00:00Z",
			connection,
		};
		const s = await h.cubicle.status();
		expect(s.state).toBe("reconnect");
		expect(s.message).toContain("revoked");
		expect(h.saved().cubicle?.token).toBeUndefined();
		expect(h.saved().cubicle?.connection.org.name).toBe("acme");
		await h.cubicle.disconnect();
		expect(h.saved().cubicle).toBeUndefined();
	});

	test("credential state: other API, expiry and reconnect reasons", () => {
		const cred = { api: "https://a", token: "t", expiresAt: "2030-01-01T00:00:00Z", connection };
		expect(credentialState(undefined, "https://a").state).toBe("disconnected");
		expect(credentialState(cred, "https://b").state).toBe("disconnected");
		expect(credentialState(cred, "https://a", Date.parse("2029-01-01")).state).toBe("connected");
		expect(credentialState(cred, "https://a", Date.parse("2031-01-01")).state).toBe("reconnect");
		const missing = cubicleError(403, {
			error: { code: "insufficient_permission", message: "", detail: { required: "boxes:exec" } },
		});
		expect(reconnectReason(missing)).toContain("boxes:exec");
		expect(
			reconnectReason(cubicleError(409, { error: { code: "conflict", message: "" } })),
		).toBeNull();
		expect(cubicleError(502, null).code).toBe("http_502");
	});
});

test("provisioning recovery never tells users to resume a capacity-rejected box", () => {
	const rejected = provisioningFailure(
		new CubicleApiError(503, "capacity", "No capacity"),
		"dries/demo",
		false,
	);
	expect(rejected.message).toContain("No box was created");
	expect(rejected.message).not.toContain("Resume");
	expect(provisioningFailure(new Error("SSH failed"), "dries/demo", true).message).toContain(
		"Resume setup",
	);
	expect(provisioningFailure(new Error("Network timeout"), "dries/demo", false).message).toContain(
		"could not be confirmed",
	);
	const removed = provisioningFailure(new Error("SSH failed"), "dries/demo", true, true).message;
	expect(removed).toContain("was removed");
	expect(removed).not.toContain("Resume");
});

test("a Box name that is taken gets the next free suffix within Cubicle's limit", () => {
	expect(freeBoxName("fix-login", [])).toBe("fix-login");
	expect(freeBoxName("fix-login", ["fix-login", "fix-login-2"])).toBe("fix-login-3");
	const long = "a".repeat(40);
	const next = freeBoxName(long, [long]);
	expect(next).toHaveLength(40);
	expect(next.endsWith("-2")).toBe(true);
});

test("a removed Box takes its SSH entry with it and leaves the rest", () => {
	const original = "Include ~/.ssh/cubicle_config\nHost work\n  HostName work.example\n";
	const withBox = cubicleSshConfig(original, "dries/demo", "cb-dries-demo", "demo.internal");
	expect(removeCubicleSshConfig(withBox, "dries/demo", "cb-dries-demo")).toBe(original);
	expect(removeCubicleSshConfig(original, "dries/demo", "cb-dries-demo")).toBe(original);
});

test("a private network that cannot be repaired stops provisioning before any Box exists", async () => {
	const h = harness(
		[
			() =>
				json(200, { identity: "acme/ateam-1", orgs: [{ name: "acme", boxCreateAllowed: true }] }),
			() => json(200, []),
		],
		undefined,
		{
			ensure: async () => {
				throw new CubicleTunnelError("helper_down", "helper is not responding");
			},
		},
	);
	h.saved().cubicle = {
		api: cubicleApi(),
		token: "test-key",
		expiresAt: "2099-01-01T00:00:00Z",
		connection,
	};
	await expect(
		h.cubicle.provision({ provider: "cubicle", name: "demo", region: "", size: "2" }, () => {}),
	).rejects.toThrow("network helper stopped running");
	expect(h.calls.some((call) => call.init.method === "POST")).toBe(false);
});

test("gold image capture waits for a stopped box and a completed snapshot operation", async () => {
	const h = harness([
		() => json(200, [{ id: "box1", name: "gold-builder" }]),
		(url) => {
			expect(url).toEndWith("/v1/boxes/box1/stop");
			return json(202, {});
		},
		() => json(200, { state: "stopping" }),
		() => json(200, { state: "stopped" }),
		(url, init) => {
			expect(url).toEndWith("/v1/boxes/box1/snapshots");
			expect(JSON.parse(String(init.body))).toEqual({ name: "gold-key" });
			return json(202, { id: "operation1" });
		},
		() => json(200, { state: "running" }),
		() => json(200, { state: "done" }),
		() => json(200, [{ id: "image1", name: "gold-key" }]),
	]);
	h.saved().cubicle = {
		api: cubicleApi(),
		token: "test-key",
		expiresAt: "2099-01-01T00:00:00Z",
		connection,
	};
	expect(await h.cubicle.captureImage("gold-builder", "gold-key")).toBe("image1");
});
