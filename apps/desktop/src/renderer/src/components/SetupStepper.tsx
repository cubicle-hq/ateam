import { Check, LoaderCircle } from "lucide-react";

export function SetupStepper({
	title,
	steps,
	active,
	detail,
}: {
	title: string;
	steps: readonly string[];
	active: number;
	detail: string;
}) {
	return (
		<section className="setup-stepper" aria-label={title}>
			<h2>{title}</h2>
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
								<LoaderCircle className="setup-spinner" size={15} />
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
