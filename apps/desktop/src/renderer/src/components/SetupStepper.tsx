import { Check, LoaderCircle } from "lucide-react";
import { CubicleLogo } from "./CubicleLogo";

export function SetupStepper({
	title,
	steps,
	active,
	detail,
	cubicle = false,
}: {
	title: string;
	steps: readonly string[];
	active: number;
	detail: string;
	/** Cubicle work: its copper, and its mark as the working indicator. */
	cubicle?: boolean;
}) {
	return (
		<section className={`setup-stepper${cubicle ? " cubicle" : ""}`} aria-label={title}>
			<h2>
				{cubicle && <CubicleLogo size={16} animated />}
				{title}
			</h2>
			<ol>
				{steps.map((step, index) => (
					<li
						key={step}
						data-state={index < active ? "done" : index === active ? "active" : "pending"}
						aria-current={index === active ? "step" : undefined}
					>
						<span className="setup-step-icon" aria-hidden="true">
							{index < active ? (
								<Check size={13} />
							) : index === active ? (
								<LoaderCircle className="setup-spinner" size={14} />
							) : null}
						</span>
						{index < active && <span className="sr-only">Completed: </span>}
						{step}
					</li>
				))}
			</ol>
			<output>{detail}</output>
		</section>
	);
}
