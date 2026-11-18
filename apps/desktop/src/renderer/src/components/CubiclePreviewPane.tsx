import type { DidFailLoadEvent, WebviewTag } from "electron";
import { Globe, RefreshCw } from "lucide-react";
import { createElement, useCallback, useEffect, useState } from "react";
import { IconButton } from "./IconButton";
import { Button } from "./ui/button";

export function CubiclePreviewPane({
	taskId,
	port,
	shown,
}: {
	taskId: string;
	port: number;
	/** The pane stays mounted behind its tab, so the app keeps its state while hidden. */
	shown: boolean;
}) {
	const [page, setPage] = useState<{ url: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [request, setRequest] = useState({ taskId, port });
	const [webview, setWebview] = useState<WebviewTag | null>(null);
	const attach = useCallback((node: WebviewTag | null) => setWebview(node), []);
	const retry = () => setRequest({ taskId, port });

	useEffect(() => {
		let cancelled = false;
		let allocated: string | undefined;
		const close = (url: string) => void window.ateamHost.closeCubiclePreview(url).catch(() => {});
		setPage(null);
		setError(null);
		void window.ateamHost.openCubiclePreview(request.taskId, request.port).then(
			(view) => {
				if (cancelled) close(view.url);
				else {
					allocated = view.url;
					setPage(view);
				}
			},
			(err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			},
		);
		return () => {
			cancelled = true;
			if (allocated) close(allocated);
		};
	}, [request]);

	useEffect(() => {
		if (!webview) return;
		const failed = (event: DidFailLoadEvent) => {
			if (event.isMainFrame && event.errorCode !== -3)
				setError(`Could not load port ${port}. Check that the app is serving HTTP on the Box.`);
		};
		webview.addEventListener("did-fail-load", failed);
		return () => {
			webview.removeEventListener("did-fail-load", failed);
		};
	}, [webview, port]);

	return (
		<div className="editor-wrap flex-col" style={{ display: shown ? "flex" : "none" }}>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
				<Globe size={16} aria-hidden="true" />
				<span className="mr-auto">Preview · Port {port}</span>
				<IconButton
					icon={RefreshCw}
					label="Reload preview"
					onClick={() => {
						if (webview && !error) webview.reload();
						else retry();
					}}
				/>
			</div>
			{page &&
				createElement("webview", {
					key: page.url,
					ref: attach,
					className: "editor-frame",
					style: { display: error ? "none" : "flex" },
					src: page.url,
					partition: "ateam-cubicle-previews",
					"aria-label": `App on port ${port}`,
				})}
			{(!page || error) && (
				<div className="m-auto flex flex-col items-center gap-2 p-4 text-center text-sm text-muted-foreground">
					<output>{error ?? `Opening port ${port}…`}</output>
					{error && (
						<Button size="sm" variant="secondary" onClick={retry}>
							Retry
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
