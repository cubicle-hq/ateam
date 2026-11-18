import { Check, ChevronDown, Globe, RefreshCw } from "lucide-react";
import { useState } from "react";
import { CubicleLogo } from "./CubicleLogo";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export function CubicleBoxMenu({
	taskId,
	active,
	onPreview,
}: {
	taskId: string;
	active: number | null;
	onPreview: (port: number) => void;
}) {
	const [ports, setPorts] = useState<number[] | null>(null);
	const [failed, setFailed] = useState(false);
	const refresh = async () => {
		setPorts(null);
		setFailed(false);
		try {
			setPorts(await window.ateamHost.listCubiclePorts(taskId));
		} catch {
			setFailed(true);
		}
	};

	return (
		<DropdownMenu modal={false} onOpenChange={(open) => open && void refresh()}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className={`iconbtn cubicle-box-menu${active !== null ? " active" : ""}`}
					aria-label="Cubicle app ports"
					title="Cubicle app ports"
				>
					<CubicleLogo />
					<ChevronDown size={12} aria-hidden="true" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				<DropdownMenuLabel>Listening ports</DropdownMenuLabel>
				{ports?.map((port) => (
					<DropdownMenuItem key={port} onSelect={() => onPreview(port)}>
						<Globe />
						Port {port}
						{active === port && <Check className="ml-auto" />}
					</DropdownMenuItem>
				))}
				{(failed || !ports?.length) && (
					<DropdownMenuLabel className="font-normal text-muted-foreground" aria-live="polite">
						{failed ? "Could not check ports" : ports ? "No app ports found" : "Checking ports…"}
					</DropdownMenuLabel>
				)}
				<DropdownMenuItem
					onSelect={(event) => {
						event.preventDefault();
						void refresh();
					}}
				>
					<RefreshCw />
					Refresh ports
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
