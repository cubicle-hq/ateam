import { spawn } from "node:child_process";
import { createServer, isIP, type Socket } from "node:net";
import { DEFAULT_BROWSER_VIEW_PORT, DEFAULT_EDITOR_PORT } from "@ateam/protocol";

export const cubicleListenersCommand = `export LC_ALL=C
printf 'engine '
systemctl show -p MainPID --value ateam.service 2>/dev/null || printf '\\n'
printf 'IPv4\\n'
ss -H -ltnp4 && printf 'IPv6\\n' && ss -H -ltnp6`;

const servicePorts = new Set([
	22,
	5900,
	DEFAULT_BROWSER_VIEW_PORT,
	DEFAULT_EDITOR_PORT,
	8787,
	9222,
	9377,
]);

export function parseCubicleListeners(output: string): Map<number, string> {
	const targets = new Map<number, string>();
	let family = 4;
	let enginePid = "";
	for (const line of output.split("\n")) {
		if (line.startsWith("engine ")) enginePid = /^engine (\d+)$/.exec(line)?.[1] ?? "";
		if (line === "IPv6") family = 6;
		const socket = /^LISTEN\s+\d+\s+\d+\s+(\S+)(.*)$/.exec(line);
		if (!socket) continue;
		const [, endpoint = "", details = ""] = socket;
		if ((enginePid && details.includes(`pid=${enginePid},`)) || details.includes('("codex",'))
			continue;
		const delimiter = endpoint.lastIndexOf(":");
		const port = Number(endpoint.slice(delimiter + 1));
		if (!Number.isInteger(port) || port < 1 || port > 65535 || servicePorts.has(port)) continue;
		let address = endpoint.slice(0, delimiter).replace(/^\[|\]$/g, "");
		if (address === "*" || address === "0.0.0.0" || address === "::")
			address = family === 4 ? "127.0.0.1" : "::1";
		if (!isIP(address)) continue;
		// Prefer IPv4 loopback when a port has listeners at more than one address.
		if (!targets.has(port) || address === "127.0.0.1") targets.set(port, address);
	}
	return targets;
}

/** Use an OS-assigned loopback port. SSH direct-tcpip forwards raw TCP, including
 * websocket upgrades, to the address reported by the Box. */
export async function openCubicleTunnel(alias: string, address: string, port: number) {
	const target = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
	const sockets = new Set<Socket>();
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		sockets.add(socket);
		const ssh = spawn(
			"ssh",
			[
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=5",
				"-o",
				"ServerAliveInterval=15",
				"-o",
				"ServerAliveCountMax=3",
				"-W",
				target,
				"--",
				alias,
			],
			{ stdio: ["pipe", "pipe", "ignore"] },
		);
		socket.on("error", () => socket.destroy());
		ssh.stdin.on("error", () => socket.destroy());
		ssh.on("error", () => socket.destroy());
		ssh.on("close", (code) => {
			if (code !== 0) socket.destroy();
		});
		socket.on("close", () => {
			sockets.delete(socket);
			ssh.kill();
		});
		socket.pipe(ssh.stdin);
		ssh.stdout.pipe(socket);
	});
	const local = await new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") resolve(address.port);
		});
	});
	return {
		url: `http://127.0.0.1:${local}/`,
		close: () => {
			server.close();
			for (const socket of sockets) socket.destroy();
		},
	};
}
