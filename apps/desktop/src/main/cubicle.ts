// Cubicle boxes through Connect Cubicle (docs/providers/cubicle-connect.md): the person
// approves Ateam for one organization in the browser, and Ateam gets its own key. Ateam
// then acts as its own account in that organization (ORG/ateam-xxxxxx), never as the
// person. The key stays in this process, encrypted at rest; the renderer only sees
// CubicleStatus. The CLI is used only for what has no HTTP route: the WireGuard tunnel
// (cubicle-tunnel.ts) and the pinned SSH configuration, both driven by the same key.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { type CreateBoxSpec, CUBICLE_BOX_NAME, type CubicleStatus } from "../shared/host";
import type { CubicleCredential, ProviderSecrets } from "./box-setup";
import { createTunnel, repairTunnelHelper, type Tunnel } from "./cubicle-tunnel";

/** Production by default; staging remains available through ATEAM_CUBICLE_API_URL. */
export const CUBICLE_STAGING_API = "https://controller-staging.tailc41a49.ts.net";
export const CUBICLE_PRODUCTION_API = "https://api.cubicle.sh";
export const cubicleApi = (): string =>
	(process.env.ATEAM_CUBICLE_API_URL || CUBICLE_PRODUCTION_API).replace(/\/+$/, "");

export const CUBICLE_TASK_SCOPE = [
	"boxes:read",
	"boxes:create",
	"boxes:power",
	"boxes:snapshot",
	// A task's Box lives as long as its worktree, and a Box whose setup failed is removed.
	"boxes:delete",
	"ssh",
	"connect",
];

const exec = promisify(execFile);
const bundledCli = process.resourcesPath
	? join(process.resourcesPath, "cubicle-cli", "bin", "cubicle")
	: undefined;
const cli =
	process.env.ATEAM_CUBICLE_CLI ||
	[bundledCli, join(homedir(), ".local/bin/cubicle")].find((path) => path && existsSync(path)) ||
	"cubicle";

export class CubicleApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail?: { required?: string },
	) {
		super(message);
	}
}

/** Cubicle's `{ error: { code, message, detail } }` body, or a stand-in for anything else. */
export function cubicleError(status: number, body: unknown): CubicleApiError {
	const e = (
		body as { error?: { code?: string; message?: string; detail?: { required?: string } } }
	)?.error;
	return new CubicleApiError(
		status,
		e?.code ?? `http_${status}`,
		e?.message ?? `Cubicle answered HTTP ${status}.`,
		e?.detail,
	);
}

/** Recovery advice must distinguish rejected creation from a box that actually exists. */
export function provisioningFailure(
	error: unknown,
	box: string,
	allocated: boolean,
	removed = false,
): Error {
	const message = error instanceof Error ? error.message : String(error);
	if (removed) return new Error(`${message} The unfinished Box ${box} was removed. Try again.`);
	if (allocated)
		return new Error(`${message} Box ${box} was retained. Choose Resume setup with the same name.`);
	if (error instanceof CubicleApiError) {
		if (error.code === "capacity")
			return new Error(`${message} No box was created. Retry after Cubicle capacity is available.`);
		if (error.status >= 400 && error.status < 500)
			return new Error(`${message} No box was created.`);
	}
	return new Error(
		`${message} Creation could not be confirmed. Check Cubicle for ${box} before retrying; use Resume setup if it exists.`,
	);
}

const KEY_EXPIRED = "Ateam's Cubicle key expired after 90 days.";
const CODE_EXPIRED = "The approval code expired. Connect again.";
/** Why a device-flow poll stopped, by Cubicle error code. */
const DEVICE_ERRORS: Record<string, string> = {
	access_denied: "Not connected: the request was cancelled in the browser.",
	expired_token: CODE_EXPIRED,
	invalid_grant: "That approval code is no longer valid. Connect again.",
};

/** What a stored credential means right now, before asking Cubicle. */
export function credentialState(
	cred: CubicleCredential | undefined,
	api: string,
	now = Date.now(),
): Pick<CubicleStatus, "state" | "message"> {
	if (!cred || cred.api !== api) return { state: "disconnected" };
	if (cred.reconnect || !cred.token) return { state: "reconnect", message: cred.reconnect };
	if (Date.parse(cred.expiresAt) <= now) return { state: "reconnect", message: KEY_EXPIRED };
	return { state: "connected" };
}

/** A 401/403 that means the person has to approve Ateam again; null for anything else. */
export function reconnectReason(e: CubicleApiError): string | null {
	if (e.code === "connection_revoked")
		return "The connection was revoked in the Cubicle Dashboard.";
	if (e.code === "connection_expired") return KEY_EXPIRED;
	if (e.code === "insufficient_permission")
		return `Ateam needs the ${e.detail?.required ?? "missing"} permission. Connect again to grant it.`;
	return null;
}

export function validateCubicleSpec(spec: Pick<CreateBoxSpec, "name" | "size">, org: string) {
	if (!CUBICLE_BOX_NAME.test(spec.name))
		throw new Error(
			"Use lowercase letters, numbers and dashes (up to 40 characters) for the box name.",
		);
	// The organization comes from Cubicle, but it lands in SSH config and CLI arguments.
	if (!CUBICLE_BOX_NAME.test(org))
		throw new Error(`Unsupported Cubicle organization name "${org}".`);
	if (![2, 4, 8].includes(Number(spec.size))) throw new Error("Choose 2, 4 or 8 vCPUs.");
}

export interface CubicleBox {
	id: string;
	name: string;
	state: string;
	privateIp: string | null;
	ssh: { ready: boolean; reason: string | null };
}

type Box = CubicleBox;

/** A completed snapshot Ateam may create Boxes from. */
export interface CubicleSnapshot {
	id: string;
	name: string;
	createdAt: string;
	box: { id: string; name: string };
}

export interface ProvisionOptions {
	/** Create the Box from this snapshot instead of the base image. */
	snapshotId?: string;
	/** A Box made for one job: when its setup fails, delete it so a retry starts clean. */
	disposable?: boolean;
}

/** The first of `base`, `base-2`, ... that no Box in the organization uses. */
export function freeBoxName(base: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	for (let n = 1; n <= 100; n++) {
		const suffix = n === 1 ? "" : `-${n}`;
		const name = base.slice(0, 40 - suffix.length).replace(/-+$/, "") + suffix;
		if (!used.has(name)) return name;
	}
	throw new Error(`No free Cubicle Box name for ${base}.`);
}

interface Me {
	identity: string;
	orgs: { name: string; boxCreateAllowed: boolean }[];
}

interface Pending {
	deviceCode: string;
	userCode: string;
	uri: string;
	cancelled: boolean;
}

export interface CubicleDeps {
	load(): ProviderSecrets;
	save(patch: ProviderSecrets): void;
	openExternal(url: string): Promise<void>;
	onConnected?(): void;
	userData: string;
	/** Replaces the CLI-backed tunnel (tests). */
	tunnel?: Tunnel;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

export function createCubicle(deps: CubicleDeps) {
	const doFetch = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let pending: Pending | null = null;
	/** The outcome of the last approval that didn't connect, shown until the next attempt. */
	let lastMessage: string | undefined;

	const stored = () => deps.load().cubicle;
	/** The stored credential, if it is usable right now. */
	const connected = () => {
		const cred = stored();
		if (credentialState(cred, cubicleApi()).state !== "connected" || !cred?.token)
			throw new Error("Connect Cubicle first.");
		return cred as CubicleCredential & { token: string };
	};
	const markReconnect = (reason: string) => {
		const cred = stored();
		if (cred) deps.save({ cubicle: { ...cred, token: undefined, reconnect: reason } });
	};

	async function request<T>(
		method: string,
		path: string,
		body?: unknown,
		token?: string,
		headers: Record<string, string> = {},
	): Promise<T> {
		const res = await doFetch(`${cubicleApi()}${path}`, {
			method,
			headers: {
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		let parsed: unknown = null;
		try {
			parsed = text ? JSON.parse(text) : null;
		} catch {
			/* a proxy's HTML error page: reported by status below */
		}
		if (!res.ok) throw cubicleError(res.status, parsed);
		return parsed as T;
	}

	/** An authenticated call; a revoked/expired/under-permitted key flips to "reconnect". */
	async function api<T>(
		method: string,
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	): Promise<T> {
		const { token } = connected();
		try {
			return await request<T>(method, path, body, token, headers);
		} catch (e) {
			if (e instanceof CubicleApiError) {
				const reason = reconnectReason(e);
				if (reason) {
					markReconnect(reason);
					throw new Error(`Cubicle: ${reason}`);
				}
				if (e.code === "api_key_not_allowed")
					throw new Error(`Cubicle refused an app key on ${method} ${path} (a bug in Ateam).`);
				throw new CubicleApiError(e.status, e.code, `Cubicle: ${e.message}`, e.detail);
			}
			throw e;
		}
	}

	async function status(): Promise<CubicleStatus> {
		const apiUrl = cubicleApi();
		if (pending) return { api: apiUrl, state: "waiting", userCode: pending.userCode };
		const cred = stored();
		const base = credentialState(cred, apiUrl);
		const shown: CubicleStatus = {
			api: apiUrl,
			...base,
			message: base.message ?? lastMessage,
			...(cred && cred.api === apiUrl
				? {
						org: cred.connection.org.name,
						permissions: cred.connection.permissions,
						expiresAt: cred.expiresAt,
					}
				: {}),
		};
		if (base.state !== "connected") return shown;
		try {
			const me = await api<Me>("GET", "/v1/me");
			const org = me.orgs.find((o) => o.name === shown.org) ?? me.orgs[0];
			return {
				...shown,
				identity: me.identity,
				boxCreateAllowed: org?.boxCreateAllowed,
				message: undefined,
			};
		} catch (e) {
			const after = credentialState(stored(), apiUrl);
			const message = e instanceof Error ? e.message : String(e);
			// Offline is not disconnected: the key is still good, Cubicle just didn't answer.
			return { ...shown, ...after, message: after.message ?? message };
		}
	}

	async function poll(p: Pending, intervalS: number, expiresInS: number) {
		const deadline = Date.now() + expiresInS * 1000;
		let approved = false;
		let wait = Math.max(1, intervalS) * 1000;
		while (!p.cancelled) {
			await sleep(wait);
			if (p.cancelled) return;
			if (Date.now() >= deadline) {
				lastMessage = CODE_EXPIRED;
				break;
			}
			try {
				const t = await request<{
					token: string;
					expiresAt: string;
					connection: CubicleCredential["connection"];
				}>("POST", "/v1/auth/device/token", { deviceCode: p.deviceCode });
				if (p.cancelled) return;
				deps.save({
					cubicle: {
						api: cubicleApi(),
						token: t.token,
						expiresAt: t.expiresAt,
						connection: t.connection,
					},
				});
				lastMessage = undefined;
				approved = true;
				break;
			} catch (e) {
				const code = e instanceof CubicleApiError ? e.code : "";
				if (code === "authorization_pending") continue;
				if (code === "slow_down") {
					wait += 5000;
					continue;
				}
				if (!(e instanceof CubicleApiError)) continue; // network blip: keep polling
				lastMessage = DEVICE_ERRORS[code] ?? `Cubicle: ${e.message}`;
				break;
			}
		}
		if (pending === p) {
			pending = null;
			if (approved) deps.onConnected?.();
		}
	}

	async function connect(scope?: string[]): Promise<CubicleStatus> {
		if (pending) return status();
		lastMessage = undefined;
		const existing = stored();
		const approved = existing?.api === cubicleApi() ? existing.connection.permissions : [];
		const requestedScope = scope ? [...new Set([...approved, ...scope])] : undefined;
		const started = await request<{
			deviceCode: string;
			userCode: string;
			verificationUriComplete: string;
			interval: number;
			expiresIn: number;
		}>("POST", "/v1/auth/device", {
			clientId: "ateam",
			...(requestedScope ? { scope: requestedScope } : {}),
		});
		const p: Pending = {
			deviceCode: started.deviceCode,
			userCode: started.userCode,
			uri: started.verificationUriComplete,
			cancelled: false,
		};
		pending = p;
		void poll(p, started.interval, started.expiresIn);
		await deps.openExternal(p.uri).catch(() => {});
		return status();
	}

	/** Keep grants already approved when an operation needs additional permissions. */
	async function ensurePermissions(scope: string[], progress?: (stage: string) => void) {
		const hasPermissions = (s: CubicleStatus) =>
			s.state === "connected" && scope.every((permission) => s.permissions?.includes(permission));
		let current = await status();
		if (hasPermissions(current)) return;
		current = await connect(scope);
		const deadline = Date.now() + 10 * 60_000;
		while (current.state === "waiting" && Date.now() < deadline) {
			progress?.(`Approve Ateam in Cubicle — code ${current.userCode ?? ""}`);
			await delay(1500);
			current = await status();
		}
		if (!hasPermissions(current))
			throw new Error(current.message || "Cubicle approval was not completed.");
	}

	async function cancel(): Promise<CubicleStatus> {
		if (pending) pending.cancelled = true;
		pending = null;
		return status();
	}

	async function openBrowser(): Promise<void> {
		if (pending) await deps.openExternal(pending.uri);
	}

	async function disconnect(): Promise<CubicleStatus> {
		await cancel();
		deps.save({ cubicle: undefined });
		lastMessage = undefined;
		return status();
	}

	/** The CLI with Ateam's key; the key travels in the environment, never in argv. */
	async function cliCall(args: string[]): Promise<string> {
		const { token } = connected();
		try {
			const { stdout } = await exec(cli, args, {
				env: { ...process.env, CB_CLI_API_URL: cubicleApi(), CB_CLI_API_KEY: token },
				timeout: 300_000,
				maxBuffer: 4 * 1024 * 1024,
			});
			return stdout;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			throw new Error(`Cubicle CLI (${args[0]}): ${msg.split(token).join("***").trim()}`);
		}
	}

	const tunnel =
		deps.tunnel ?? createTunnel({ cli: cliCall, repair: () => repairTunnelHelper(cli) });

	const orgName = () => connected().connection.org.name;
	const listBoxes = () => api<Box[]>("GET", `/v1/orgs/${encodeURIComponent(orgName())}/boxes`);
	async function findBox(name: string): Promise<Box | undefined> {
		return (await listBoxes()).find((box) => box.name === name);
	}

	async function waitForBox(id: string, progress: (stage: string) => void): Promise<Box> {
		const deadline = Date.now() + 15 * 60_000;
		let shown = "";
		while (Date.now() < deadline) {
			const box = await api<Box>("GET", `/v1/boxes/${encodeURIComponent(id)}`);
			if (box.state === "failed")
				throw new Error(`The box failed to start: ${box.ssh.reason ?? "no reason given"}.`);
			if (box.state === "running" && box.ssh.ready && box.privateIp) return box;
			const now = `Waiting for the box: ${box.state}${box.ssh.reason ? ` (${box.ssh.reason})` : ""}`;
			if (now !== shown) {
				shown = now;
				progress(now);
			}
			await sleep(3000);
		}
		throw new Error("The box did not become ready within 15 minutes.");
	}

	/** Resume a Box that Ateam provisioned, only when a user asks to use it. */
	async function wakeBox(alias: string): Promise<void> {
		if (!/^cb-[a-z0-9-]+$/.test(alias)) return;
		const configPath = join(homedir(), ".ssh/config");
		if (!existsSync(configPath)) return;
		const config = readFileSync(configPath, "utf8");
		const box = [...config.matchAll(/^# Ateam Cubicle ([a-z0-9-]+)\/([a-z0-9-]+)\r?$/gm)].find(
			([, org, name]) => `cb-${org}-${name}` === alias,
		);
		if (!box) return;
		const [, org, name] = box;
		if (org !== connected().connection.org.name)
			throw new Error(`Connect Cubicle to ${org} to open this Box.`);

		const boxes = await api<Box[]>("GET", `/v1/orgs/${encodeURIComponent(org)}/boxes`);
		const target = boxes.find((candidate) => candidate.name === name);
		if (!target) throw new Error(`Cubicle could not find ${org}/${name}.`);
		if (["hibernating", "hibernated", "stopping", "stopped"].includes(target.state)) {
			await api("POST", `/v1/boxes/${encodeURIComponent(target.id)}/start`);
		}
		await waitForBox(target.id, () => {});
		// Waking is a person's action: a dead tunnel helper may be repaired here.
		await tunnel.ensure({ interactive: true });
		await reachOverSsh(alias, () => {});
	}

	/** SSH can lag a "connected" tunnel whose session went stale: refresh it once. */
	async function reachOverSsh(alias: string, progress: (stage: string) => void): Promise<void> {
		const { waitForSsh } = await import("./box-setup");
		try {
			await waitForSsh(alias, 12);
		} catch {
			progress("Refreshing the private network");
			await tunnel.ensure({ fresh: true, progress });
			await waitForSsh(alias, 24);
		}
	}

	async function provision(
		spec: CreateBoxSpec,
		progress: (stage: string) => void,
		{ snapshotId, disposable = false }: ProvisionOptions = {},
	): Promise<string> {
		const org = connected().connection.org.name;
		validateCubicleSpec(spec, org);
		const box = `${org}/${spec.name}`;
		const alias = `cb-${org}-${spec.name}`;
		progress("Checking the Cubicle connection");
		const me = await api<Me>("GET", "/v1/me");
		const orgInfo = me.orgs.find((o) => o.name === org);
		const boxes = await api<Box[]>("GET", `/v1/orgs/${encodeURIComponent(org)}/boxes`);
		const existing = boxes.find((b) => b.name === spec.name);
		if (existing && !spec.resume)
			throw new Error(`${box} already exists. Choose Resume setup to use it, or pick a new name.`);
		if (!existing && spec.resume)
			throw new Error(`${box} does not exist. Switch to Create new box.`);
		if (!existing && !orgInfo?.boxCreateAllowed)
			throw new Error(`Box creation is not enabled for the ${org} organization.`);
		// Before any Box exists: a tunnel that cannot be repaired must not leave one behind.
		progress("Checking the private network");
		await tunnel.ensure({ interactive: true, progress });
		const configPath = join(homedir(), ".ssh/config");
		const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
		const marker = `# Ateam Cubicle ${box}`;
		if (new RegExp(`^Host\\s+${alias}(?:\\s|$)`, "m").test(config) && !config.includes(marker))
			throw new Error(`SSH alias ${alias} is already in use.`);
		const keyPath = join(deps.userData, "box-keys", `${alias}.key`);
		if (!existsSync(keyPath)) {
			// Lazily: box-setup loads electron, which this module's tests run without.
			const { generateBoxKey } = await import("./box-setup");
			generateBoxKey(deps.userData, alias);
		}
		progress("Registering this app's SSH key");
		const publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
		const keys = await api<{ publicKey?: string; fingerprint: string }[]>("GET", "/v1/keys");
		const fingerprint = await sshFingerprint(`${keyPath}.pub`);
		if (!keys.some((k) => sameKey(k.publicKey, publicKey) || k.fingerprint === fingerprint)) {
			try {
				await api("POST", "/v1/keys", { publicKey });
			} catch (e) {
				// Already registered (a race with another attempt) is fine.
				if (!/already|conflict|exists/i.test(e instanceof Error ? e.message : "")) throw e;
			}
		}
		let allocated = Boolean(existing);
		let created: Box | undefined;
		try {
			let target: Box;
			if (!existing) {
				progress("Creating your Cubicle box");
				const vcpus = Number(spec.size);
				target = await api<Box>(
					"POST",
					`/v1/orgs/${encodeURIComponent(org)}/boxes`,
					{
						name: spec.name,
						vcpus,
						memoryMiB: vcpus * 2048,
						diskGiB: 20,
						start: true,
						...(snapshotId ? { snapshotId } : {}),
					},
					{ "idempotency-key": randomUUID() },
				);
				created = target;
			} else {
				target = existing;
				if (existing.state !== "running") {
					progress("Starting the existing box");
					await api("POST", `/v1/boxes/${encodeURIComponent(existing.id)}/start`);
				}
			}
			allocated = true;
			await waitForBox(target.id, progress);
			progress("Configuring trusted SSH over the private tunnel");
			await tunnel.ensure({ progress });
			await cliCall(["ssh-config", box, "--alias", alias, "--identity", keyPath]);
			// The Cubicle CLI emits IdentityFile without quoting macOS app paths.
			const managedPath = join(homedir(), ".ssh/cubicle_config");
			writeFileSync(managedPath, quoteCubicleIdentity(readFileSync(managedPath, "utf8"), keyPath), {
				mode: 0o600,
			});
			// Use Cubicle DNS so reconnects follow the box without pinning an old IP.
			const hostname = `${spec.name}.${org}.cubicle.internal`;
			const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
			writeFileSync(configPath, cubicleSshConfig(current, box, alias, hostname), { mode: 0o600 });
			progress("Waiting for SSH");
			await reachOverSsh(alias, progress);
			return alias;
		} catch (error) {
			// A Box this call created for one job is worthless half-made: remove it, so the
			// retry is a plain retry and nothing lingers in the organization.
			let removed = false;
			if (created && disposable) {
				removed = await api("DELETE", `/v1/boxes/${encodeURIComponent(created.id)}`).then(
					() => true,
					() => false,
				);
				if (removed) await forgetSshEntry(box, alias);
			}
			throw provisioningFailure(error, box, allocated, removed);
		}
	}

	/**
	 * Forget how to reach a deleted Box. Its multiplexed SSH connection goes first: a new
	 * Box may take the same name within seconds, and must not be handed the old socket.
	 */
	async function forgetSshEntry(box: string, alias: string): Promise<void> {
		await exec("ssh", ["-O", "exit", alias], { timeout: 5000 }).catch(() => {});
		const configPath = join(homedir(), ".ssh/config");
		try {
			const current = readFileSync(configPath, "utf8");
			const next = removeCubicleSshConfig(current, box, alias);
			if (next !== current) writeFileSync(configPath, next, { mode: 0o600 });
		} catch {
			/* nothing to forget */
		}
	}

	/** Delete a Box Ateam created, with its snapshots. A missing Box is already gone. */
	async function deleteBox(name: string): Promise<void> {
		const org = orgName();
		const box = await findBox(name);
		if (box) await api("DELETE", `/v1/boxes/${encodeURIComponent(box.id)}`);
		await forgetSshEntry(`${org}/${name}`, `cb-${org}-${name}`);
	}

	/** The organization name behind a `cb-<org>-<box>` alias Ateam wrote. */
	function boxOfAlias(alias: string): string | undefined {
		const org = stored()?.connection.org.name;
		const prefix = `cb-${org}-`;
		return org && alias.startsWith(prefix) ? alias.slice(prefix.length) : undefined;
	}

	/** The SSH alias `provision` gives a Box of the connected organization. */
	function aliasOfBox(name: string): string | undefined {
		const org = stored()?.connection.org.name;
		return org ? `cb-${org}-${name}` : undefined;
	}

	const boxNames = async () => (await listBoxes()).map((box) => box.name);

	async function listSnapshots(): Promise<CubicleSnapshot[]> {
		return api<CubicleSnapshot[]>("GET", `/v1/orgs/${encodeURIComponent(orgName())}/snapshots`);
	}

	async function findGoldImage(name: string): Promise<string | undefined> {
		return (await listSnapshots()).find((snapshot) => snapshot.name === name)?.id;
	}

	function connectionKey(): string | undefined {
		const cred = stored();
		if (!cred?.token || credentialState(cred, cubicleApi()).state !== "connected") return;
		return JSON.stringify([cred.api, cred.connection.org.id, cred.connection.id]);
	}

	async function findImageBuilder(boxName: string): Promise<Box> {
		const box = await findBox(boxName);
		if (!box) throw new Error(`Image builder ${boxName} was not found.`);
		return box;
	}

	async function stopBox(boxName: string): Promise<void> {
		const box = await findImageBuilder(boxName);
		if (box.state !== "stopped") await api("POST", `/v1/boxes/${box.id}/stop`);
	}

	/** Only called on Ateam's dedicated image builder. */
	async function captureImage(boxName: string, name: string): Promise<string> {
		const box = await findImageBuilder(boxName);
		if (box.state !== "stopped") await api("POST", `/v1/boxes/${box.id}/stop`);
		const deadline = Date.now() + 15 * 60_000;
		for (;;) {
			const current = await api<Box>("GET", `/v1/boxes/${box.id}`);
			if (current.state === "stopped") break;
			if (current.state === "failed" || Date.now() >= deadline)
				throw new Error(`Box ${boxName} did not stop.`);
			await sleep(2000);
		}
		const operation = await api<{ id: string }>(
			"POST",
			`/v1/boxes/${box.id}/snapshots`,
			{ name },
			{ "idempotency-key": randomUUID() },
		);
		const snapshotDeadline = Date.now() + 30 * 60_000;
		for (;;) {
			const result = await api<{ state: string; error?: unknown }>(
				"GET",
				`/v1/operations/${operation.id}`,
			);
			if (result.state === "done") break;
			if (["failed", "unknown"].includes(result.state) || Date.now() >= snapshotDeadline)
				throw new Error(
					`The snapshot did not complete: ${JSON.stringify(result.error ?? result.state)}`,
				);
			await sleep(2000);
		}
		const id = await findGoldImage(name);
		if (!id) throw new Error("Cubicle finished the snapshot but did not list it.");
		return id;
	}

	return {
		status,
		connect,
		cancel,
		openBrowser,
		disconnect,
		provision,
		wakeBox,
		tunnel,
		deleteBox,
		findBox,
		boxNames,
		boxOfAlias,
		aliasOfBox,
		listSnapshots,
		ensurePermissions,
		connectionKey,
		findGoldImage,
		stopBox,
		captureImage,
	};
}

export type Cubicle = ReturnType<typeof createCubicle>;

const sameKey = (a: string | undefined, b: string) =>
	!!a && a.split(" ").slice(0, 2).join(" ") === b.split(" ").slice(0, 2).join(" ");

async function sshFingerprint(pubPath: string): Promise<string> {
	try {
		const { stdout } = await exec("ssh-keygen", ["-l", "-E", "sha256", "-f", pubPath]);
		return stdout.split(" ")[1] ?? "";
	} catch {
		return "";
	}
}

export function cubicleSshConfig(
	current: string,
	box: string,
	alias: string,
	hostname: string,
): string {
	const marker = `# Ateam Cubicle ${box}`;
	const multiplex = "  ControlMaster auto\n  ControlPersist 120\n  ControlPath ~/.ssh/ateam-%C\n";
	const block = `${marker}\nHost ${alias}\n  HostName ${hostname}\n${multiplex}Host *\n`;
	const pattern = new RegExp(
		`# Ateam Cubicle ${box}\\nHost ${alias}\\n  HostName [^\\n]+\\n(?:  ControlMaster auto\\n  ControlPersist 120\\n  ControlPath ~/\\.ssh/ateam-%C\\n)?Host \\*\\n`,
	);
	if (current.includes(marker) && !pattern.test(current))
		throw new Error("The app's SSH entry was edited. Restore it before resuming setup.");
	return current.includes(marker) ? current.replace(pattern, block) : `${block}\n${current}`;
}

/** Drop the entry `cubicleSshConfig` wrote for a Box that no longer exists. */
export function removeCubicleSshConfig(current: string, box: string, alias: string): string {
	const pattern = new RegExp(
		`# Ateam Cubicle ${box}\\nHost ${alias}\\n  HostName [^\\n]+\\n(?:  ControlMaster auto\\n  ControlPersist 120\\n  ControlPath ~/\\.ssh/ateam-%C\\n)?Host \\*\\n\\n?`,
	);
	return current.replace(pattern, "");
}

export function quoteCubicleIdentity(config: string, keyPath: string): string {
	if (/["\n\r]/.test(keyPath)) throw new Error("Unsupported SSH identity path.");
	return config
		.split("\n")
		.map((line) =>
			line.trim() === `IdentityFile ${keyPath}` ? `    IdentityFile "${keyPath}"` : line,
		)
		.join("\n");
}
