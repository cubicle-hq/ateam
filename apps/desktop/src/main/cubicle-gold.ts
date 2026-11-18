import { createHash, randomUUID } from "node:crypto";
import { getAgent } from "@ateam/agents";
import type { CubicleImageStatus, CubicleImageStep } from "../shared/host";
import type { Cubicle } from "./cubicle";

const agents = ["claude", "codex", "opencode"].map((id) => {
	const agent = getAgent(id);
	if (!agent?.install) throw new Error(`Missing installer for ${id}.`);
	return { label: agent.label, bin: agent.bin, install: agent.install };
});

const nodeToolchain = `set -eu
version=v24.21.0
archive=node-$version-linux-x64.tar.gz
dist=https://nodejs.org/dist/$version
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cd "$tmp"
curl -fsSLO "$dist/$archive"
curl -fsS "$dist/SHASUMS256.txt" > SHASUMS256.txt
awk -v name="$archive" '$2 == name' SHASUMS256.txt | sha256sum -c -
tar -xzf "$archive"
sudo -n mv "node-$version-linux-x64" "/opt/node-$version"
for bin in node npm npx; do
  sudo -n ln -sfn "/opt/node-$version/bin/$bin" "/usr/local/bin/$bin"
done
/usr/local/bin/node --version
/usr/local/bin/npm --version`;

// Warm system packages without generating a Chrome profile, VNC password or pairing token.
const desktopPackages = `set -eu
sudo -n apt-get update -qq
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
chmod 755 "$tmp"
curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  xvfb openbox xfdesktop4 xfce4-panel xfconf dbus-daemon x11vnc novnc websockify fonts-noto-color-emoji "$tmp/chrome.deb"`;

interface ImageDependencies {
	cubicle: Pick<
		Cubicle,
		"connectionKey" | "findGoldImage" | "provision" | "captureGoldImage" | "stopImageBuilder"
	>;
	runtimeVersion: string;
	installWallpaper: string;
	installEngine(alias: string): Promise<void>;
	remote(alias: string, command: string): Promise<void>;
}

type Attempt = { status: CubicleImageStatus; image: Promise<string | undefined> };

/** Image builds use a fresh Box. No project, engine connection or credentials enter it. */
export function createCubicleImageCache({
	cubicle,
	runtimeVersion,
	installWallpaper,
	installEngine,
	remote,
}: ImageDependencies) {
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				"ateam-runtime-v1",
				runtimeVersion,
				nodeToolchain,
				agents,
				desktopPackages,
				installWallpaper,
			]),
		)
		.digest("hex")
		.slice(0, 20);
	const imageName = `ateam-runtime-${fingerprint}`;
	const attempts = new Map<string, Attempt>();

	function status(): CubicleImageStatus | undefined {
		const key = cubicle.connectionKey();
		return key ? attempts.get(key)?.status : undefined;
	}

	function prepare(retry = false): Promise<string | undefined> {
		const key = cubicle.connectionKey();
		if (!key) return Promise.resolve(undefined);
		const existing = attempts.get(key);
		if (existing && (!retry || existing.status.state !== "failed")) return existing.image;

		const builder = `gold-runtime-${fingerprint.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
		const assertConnection = () => {
			if (cubicle.connectionKey() !== key) throw new Error("The Cubicle connection changed.");
		};
		const progress = (step: CubicleImageStep, detail: string) => {
			attempt.status = { state: "building", step, detail };
		};

		// Schedule the work after the attempt is visible, so status and task launches join it.
		let allocated = false;
		const image = Promise.resolve().then(async () => {
			try {
				assertConnection();
				const found = await cubicle.findGoldImage(imageName);
				assertConnection();
				if (found) {
					attempt.status = { state: "ready" };
					return found;
				}
				const alias = await cubicle.provision(
					{ provider: "cubicle", name: builder, region: "", size: "2" },
					(detail) => progress("box", detail),
				);
				allocated = true;
				assertConnection();
				progress("runtime", "Installing the Ateam engine");
				await installEngine(alias);
				assertConnection();
				progress("runtime", "Installing Node.js and npm");
				await remote(alias, nodeToolchain);
				for (const agent of agents) {
					assertConnection();
					progress("runtime", `Installing ${agent.label}`);
					await remote(
						alias,
						`set -e
if ! command -v ${agent.bin} >/dev/null; then ${agent.install}; fi
bash -lc 'command -v ${agent.bin}'`,
					);
				}
				assertConnection();
				progress("runtime", "Installing Chrome and the desktop packages");
				await remote(alias, desktopPackages);
				assertConnection();
				await remote(alias, installWallpaper);
				assertConnection();
				progress("snapshot", "Stopping the builder and saving its disk");
				await remote(
					alias,
					'set -eu; sudo -n systemctl stop ateam.service; rm -rf -- "$HOME/.ateam"; sync',
				);
				assertConnection();
				const id = await cubicle.captureGoldImage(builder, imageName);
				assertConnection();
				attempt.status = { state: "ready" };
				return id;
			} catch (error) {
				// If the image failed after allocation, stop the builder to release its CPU and RAM.
				if (allocated && cubicle.connectionKey() === key) {
					await cubicle.stopImageBuilder(builder).catch(() => {});
				}
				const why = error instanceof Error ? error.message : String(error);
				attempt.status = {
					state: "failed",
					message: allocated ? `${why} Builder ${builder} was retained.` : why,
				};
				return undefined;
			}
		});
		const attempt: Attempt = {
			status: { state: "building", step: "box", detail: "Looking for an existing Ateam image" },
			image,
		};
		attempts.set(key, attempt);
		return image;
	}

	return { prepare, status };
}
