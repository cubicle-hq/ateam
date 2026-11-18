import { expect, test } from "bun:test";
import { bundledInstall, findEngineBundle, sendEngineBundle } from "./engine-bundle";

test("finds the packaged bundle, then a checkout's, and nothing when a file is missing", () => {
	const has = (paths: string[]) => (path: string) => paths.includes(path);
	expect(
		findEngineBundle(
			[undefined, "/res/ateam-engine", "/repo/packages/server"],
			has(["/res/ateam-engine/ateam-server.tar.gz", "/res/ateam-engine/install.sh"]),
		),
	).toEqual({
		tarball: "/res/ateam-engine/ateam-server.tar.gz",
		installer: "/res/ateam-engine/install.sh",
	});
	expect(
		findEngineBundle(
			["/res/ateam-engine", "/repo/packages/server"],
			has([
				"/repo/packages/server/dist/ateam-server.tar.gz",
				"/repo/packages/server/scripts/install.sh",
			]),
		)?.installer,
	).toBe("/repo/packages/server/scripts/install.sh");
	// An installer without the engine it installs is not a bundle.
	expect(
		findEngineBundle(["/repo/packages/server"], has(["/repo/packages/server/scripts/install.sh"])),
	).toBeUndefined();
});

test("the engine is copied to the box before it is installed from there", async () => {
	const calls: string[][] = [];
	await sendEngineBundle(
		"cb-acme-demo",
		{ tarball: "/b/ateam-server.tar.gz", installer: "/b/install.sh" },
		["-o", "StrictHostKeyChecking=accept-new"],
		async (file, args) => void calls.push([file, ...args]),
	);
	expect(calls.map((call) => call[0])).toEqual(["ssh", "scp"]);
	expect(calls[0]?.slice(-2)).toEqual(["cb-acme-demo", "mkdir -p .ateam-install"]);
	expect(calls[1]?.slice(-3)).toEqual([
		"/b/ateam-server.tar.gz",
		"/b/install.sh",
		"cb-acme-demo:.ateam-install/",
	]);
	expect(calls[1]).toContain("StrictHostKeyChecking=accept-new");

	await expect(
		sendEngineBundle("cb-acme-demo", { tarball: "/t", installer: "/i" }, [], async () => {
			throw new Error("Connection refused");
		}),
	).rejects.toThrow('Setup of "cb-acme-demo" failed: the Ateam engine could not be copied');
});

test("the install runs the copied installer on the copied engine and cleans up after itself", () => {
	const shell = bundledInstall("ATEAM_WS_ADDR=100.64.0.1:8787 ", "--service --browser");
	expect(shell).toContain('ATEAM_TARBALL="$HOME/.ateam-install/ateam-server.tar.gz"');
	expect(shell).toContain('bash "$HOME/.ateam-install/install.sh" --service --browser');
	expect(shell.endsWith("exit $code")).toBe(true);
	// It is embedded in `bash -lc '…'`.
	expect(shell).not.toContain("'");
});
