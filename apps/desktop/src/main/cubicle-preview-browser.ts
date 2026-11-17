import { session, type WebContents } from "electron";
import { openCubicleTunnel } from "./cubicle-preview";

const partition = "ateam-cubicle-previews";
const previews = new WeakMap<WebContents, Map<string, () => void>>();
const allowedOrigins = new Set<string>();
let configured = false;

export async function openCubiclePreviewBrowser(
	owner: WebContents,
	alias: string,
	address: string,
	port: number,
): Promise<{ url: string }> {
	const tunnel = await openCubicleTunnel(alias, address, port);
	if (owner.isDestroyed()) {
		tunnel.close();
		throw new Error("The preview window was closed.");
	}
	let owned = previews.get(owner);
	if (!owned) {
		owned = new Map();
		previews.set(owner, owned);
		const registered = owned;
		owner.once("destroyed", () => {
			for (const close of registered.values()) close();
			registered.clear();
		});
	}
	const origin = new URL(tunnel.url).origin;
	allowedOrigins.add(origin);
	owned.set(tunnel.url, () => {
		allowedOrigins.delete(origin);
		tunnel.close();
	});
	return { url: tunnel.url };
}

export function closeCubiclePreviewBrowser(owner: WebContents, url: string): void {
	const owned = previews.get(owner);
	owned?.get(url)?.();
	owned?.delete(url);
}

export function guardCubiclePreviewBrowser(owner: WebContents): void {
	const previewSession = session.fromPartition(partition);
	if (!configured) {
		configured = true;
		previewSession.setPermissionRequestHandler((_contents, _permission, callback) =>
			callback(false),
		);
		previewSession.setPermissionCheckHandler(() => false);
		previewSession.on("will-download", (event) => event.preventDefault());
		previewSession.webRequest.onBeforeRequest(
			{ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
			(details, callback) => {
				const url = new URL(details.url);
				const loopback =
					url.hostname === "localhost" ||
					url.hostname.startsWith("127.") ||
					url.hostname === "[::1]" ||
					url.hostname.endsWith(".localhost");
				const origin = url.origin.replace(/^ws/, "http");
				callback({ cancel: loopback && !allowedOrigins.has(origin) });
			},
		);
	}

	owner.on("will-attach-webview", (event, preferences, params) => {
		if (!params.src || !previews.get(owner)?.has(params.src) || params.partition !== partition) {
			event.preventDefault();
			return;
		}
		delete preferences.preload;
		preferences.session = previewSession;
		preferences.nodeIntegration = false;
		preferences.nodeIntegrationInSubFrames = false;
		preferences.contextIsolation = true;
		preferences.sandbox = true;
		preferences.webSecurity = true;
	});

	owner.on("did-attach-webview", (_event, guest) => {
		guest.setWindowOpenHandler(() => ({ action: "deny" }));
		// Guest top-level navigation stays on its forwarded app. Relative links,
		// assets and hot reload use the same endpoint.
		const check = (event: Electron.Event, target: string) => {
			try {
				const origin = new URL(target).origin;
				const owned = previews.get(owner);
				const current = guest.getURL();
				if (owned?.has(`${origin}/`) && (!current || new URL(current).origin === origin)) return;
			} catch {
				// An empty or invalid URL has no preview origin.
			}
			event.preventDefault();
		};
		guest.on("will-navigate", (event, url) => check(event, url));
		guest.on("will-redirect", (event, url, _inPlace, mainFrame) => {
			if (mainFrame) check(event, url);
		});
	});
}
