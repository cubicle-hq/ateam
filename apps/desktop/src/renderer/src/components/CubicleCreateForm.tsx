import { type ReactNode, useCallback, useEffect, useState } from "react";
import { CUBICLE_BOX_NAME, type CubicleImageStep, type CubicleStatus } from "../../../shared/host";
import { stripAnsi } from "../lib/ansi";
import { CubicleLogo } from "./CubicleLogo";
import { SetupStepper } from "./SetupStepper";

const IMAGE_STEPS: Record<CubicleImageStep, string> = {
	box: "Prepare builder Box",
	runtime: "Install Ateam tools",
	snapshot: "Save reusable image",
};

// Connect Cubicle, then create a box in the one organization the connection is bound to.
// States: Not connected → Waiting for browser → Connected → Reconnect needed.
export function CubicleCreateForm({
	onDone,
	onBusy,
}: {
	onDone: (alias: string) => void;
	onBusy: (busy: boolean) => void;
}) {
	const [cubicle, setCubicle] = useState<CubicleStatus | null>(null);
	const [name, setName] = useState("");
	const [size, setSize] = useState("2");
	const [resume, setResume] = useState(false);
	const [busy, setBusy] = useState(false);
	const [stage, setStage] = useState("");
	const [log, setLog] = useState("");
	const [error, setError] = useState("");

	const act = useCallback(async (fn: () => Promise<CubicleStatus>) => {
		setError("");
		try {
			setCubicle(await fn());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);
	useEffect(() => {
		void act(() => window.ateamHost.cubicleStatus());
	}, [act]);
	// The approval happens in the browser; check back until the main process has an answer.
	const image = cubicle?.image;
	const preparingImage = image?.state === "building";
	const trackingSetup = cubicle?.state === "waiting" || preparingImage;
	useEffect(() => {
		if (!trackingSetup) return;
		const t = setInterval(() => void act(() => window.ateamHost.cubicleStatus()), 1500);
		return () => clearInterval(t);
	}, [trackingSetup, act]);

	const run = async () => {
		setBusy(true);
		onBusy(true);
		setError("");
		setLog("");
		const offProgress = window.ateamHost.onCreateProgress((e) => setStage(e.stage));
		const offLog = window.ateamHost.onInstallLog((e) => setLog((s) => (s + e.chunk).slice(-30000)));
		try {
			const status = await window.ateamHost.createBox({
				provider: "cubicle",
				name,
				region: cubicle?.org ?? "",
				size,
				resume,
			});
			if (status.alias) onDone(status.alias);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			// A revoked or expired key shows up here first; reflect it.
			void window.ateamHost.cubicleStatus().then(setCubicle, () => {});
		} finally {
			offProgress();
			offLog();
			setBusy(false);
			onBusy(false);
		}
	};

	const apiHost = cubicle ? cubicle.api.replace(/^https?:\/\//, "") : "";
	const staging = apiHost.includes("staging");
	return (
		<div className="cb-form">
			<div className="cb-help">
				Create a private Linux box on Cubicle. Ateam connects with its own Cubicle account,
				registers its SSH key, installs the engine and connects automatically.
			</div>

			{cubicle?.state === "disconnected" && (
				<>
					<div className="cb-help">
						Approve Ateam for one Cubicle organization in your browser. First-time setup builds one
						reusable image on a Cubicle Box. You need the owner or admin role in that organization.
					</div>
					<CubicleButton onClick={() => void act(() => window.ateamHost.cubicleConnect())}>
						Connect Cubicle
					</CubicleButton>
				</>
			)}

			{cubicle?.state === "waiting" && (
				<>
					<div className="cb-help">
						Waiting for the browser. Check that Cubicle shows this code, pick the organization and
						choose “Authorize Ateam”.
					</div>
					<div
						className="cb-input"
						style={{ fontFamily: "monospace", fontSize: 18, textAlign: "center", letterSpacing: 2 }}
					>
						{cubicle.userCode}
					</div>
					<div style={{ display: "flex", gap: 8 }}>
						<button
							type="button"
							className="cb-back"
							onClick={() => void window.ateamHost.cubicleOpenBrowser()}
						>
							Open browser again
						</button>
						<button
							type="button"
							className="cb-back"
							onClick={() => void act(() => window.ateamHost.cubicleCancel())}
						>
							Cancel
						</button>
					</div>
				</>
			)}

			{cubicle?.state === "reconnect" && (
				<>
					<div className="cb-error">
						Reconnect Cubicle{cubicle.org ? ` (${cubicle.org})` : ""}.{" "}
						{cubicle.message ?? "The connection is no longer valid."} Boxes Ateam created are kept.
					</div>
					<CubicleButton onClick={() => void act(() => window.ateamHost.cubicleConnect())}>
						Reconnect Cubicle
					</CubicleButton>
				</>
			)}

			{cubicle?.state === "connected" && (
				<>
					<div className="cb-hint">
						Connected to {cubicle.org}
						{cubicle.identity ? ` as ${cubicle.identity}` : ""}
						{cubicle.expiresAt
							? ` · key valid until ${new Date(cubicle.expiresAt).toLocaleDateString()}`
							: ""}
						{" · "}
						<button
							type="button"
							className="cb-back"
							style={{ display: "inline", padding: 0 }}
							disabled={busy}
							onClick={() => void act(() => window.ateamHost.cubicleDisconnect())}
						>
							Disconnect
						</button>
					</div>
					{image?.state === "building" && (
						<SetupStepper
							title="Preparing the Ateam image"
							cubicle
							steps={Object.values(IMAGE_STEPS)}
							active={Object.keys(IMAGE_STEPS).indexOf(image.step)}
							detail={image.detail}
						/>
					)}
					{image?.state === "ready" && <div className="cb-hint">Reusable Ateam image ready</div>}
					{image?.state === "failed" && (
						<>
							<output className="cb-hint block">Image setup stopped. {image.message}</output>
							<button
								type="button"
								className="cb-back"
								onClick={() => void act(() => window.ateamHost.cubicleStatus(true))}
							>
								Retry image setup
							</button>
						</>
					)}
					{!image &&
						cubicle.boxCreateAllowed &&
						!cubicle.permissions?.includes("boxes:snapshot") && (
							<CubicleButton onClick={() => void act(() => window.ateamHost.cubicleConnect())}>
								Enable reusable image
							</CubicleButton>
						)}
					{cubicle.permissions && (
						<div className="cb-hint">Permissions: {cubicle.permissions.join(", ")}</div>
					)}
					{cubicle.message && <div className="cb-hint">{cubicle.message}</div>}
					{cubicle.boxCreateAllowed === false && !resume && (
						<div className="cb-error">Box creation is not enabled for {cubicle.org}.</div>
					)}
					<label className="cb-row">
						<span>Box name</span>
						<input
							className="cb-input"
							placeholder="my-project-dev"
							value={name}
							disabled={busy}
							onChange={(e) => setName(e.target.value.toLowerCase())}
						/>
					</label>
					<label className="cb-row">
						<span>Setup</span>
						<select
							className="cb-input"
							value={resume ? "resume" : "new"}
							disabled={busy}
							onChange={(e) => setResume(e.target.value === "resume")}
						>
							<option value="new">Create new box</option>
							<option value="resume">Resume setup on a box Ateam created</option>
						</select>
					</label>
					{!resume && (
						<label className="cb-row">
							<span>Resources · 20 GB disk</span>
							<select
								className="cb-input"
								value={size}
								disabled={busy}
								onChange={(e) => setSize(e.target.value)}
							>
								<option value="2">2 vCPU · 4 GB RAM</option>
								<option value="4">4 vCPU · 8 GB RAM</option>
								<option value="8">8 vCPU · 16 GB RAM</option>
							</select>
						</label>
					)}
					<div className="cb-help">
						{resume
							? "Uses the existing box without changing its size or files."
							: `Created in ${cubicle.org} using available capacity. Usage is billed by Cubicle.`}{" "}
						Agent and GitHub sign-in follow on the box setup page.
					</div>
				</>
			)}

			{!cubicle && !error && <div className="cb-hint">Checking Cubicle…</div>}
			{stage && <output className="cb-hint">{busy ? stage : "Setup stopped"}</output>}
			{log && <pre className="cb-log">{stripAnsi(log)}</pre>}
			{error && (
				<div role="alert" className="cb-error">
					{error}
				</div>
			)}
			{!cubicle && error && (
				<button
					type="button"
					className="cb-back"
					onClick={() => void act(() => window.ateamHost.cubicleStatus())}
				>
					Check again
				</button>
			)}
			{cubicle?.state === "connected" && (
				<CubicleButton
					disabled={
						busy ||
						(!resume && (preparingImage || cubicle.boxCreateAllowed === false)) ||
						!CUBICLE_BOX_NAME.test(name)
					}
					onClick={() => void run()}
				>
					{busy
						? "Setting up your box…"
						: resume
							? "Resume setup & connect"
							: "Create box & connect"}
				</CubicleButton>
			)}
			{cubicle && (
				<div className="cb-hint">
					{staging ? "Staging" : "Cubicle"} · {apiHost} · the private tunnel needs{" "}
					<code>cubicle tunnel install</code> once
				</div>
			)}
		</div>
	);
}

/** Cubicle's copper primary button, its mark drawn in the button's text colour. */
function CubicleButton({
	children,
	disabled,
	onClick,
}: {
	children: ReactNode;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button type="button" className="cb-create cb-cubicle" disabled={disabled} onClick={onClick}>
			<CubicleLogo size={15} color="currentColor" />
			{children}
		</button>
	);
}
