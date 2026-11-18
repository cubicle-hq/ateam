// Cubicle brand mark (four I-beam quarters around a star-shaped gap), inlined so it
// works under the app's CSP and offline — never hotlinked. Defaults to Cubicle's copper;
// pass "currentColor" to draw it in the surrounding text colour (e.g. on a copper button).
const QUARTER =
	"M24 20H118Q122 20 122 24V118Q122 122 118 122H24Q20 122 20 118V117Q20 113 24 113H70V84Q70 58 44 58H24Q20 58 20 54V24Q20 20 24 20Z";

// Clockwise from the top left, so the animated mark lights its quarters in a circle.
const QUARTERS = [
	undefined,
	"matrix(-1 0 0 1 256 0)",
	"matrix(-1 0 0 -1 256 256)",
	"matrix(1 0 0 -1 0 256)",
];

export function CubicleLogo({
	size = 16,
	color = "#BC5F35",
	animated = false,
}: {
	size?: number | string;
	color?: string;
	/** Light the quarters one after another: the mark as a working indicator. */
	animated?: boolean;
}) {
	return (
		<svg
			className={animated ? "cubicle-logo-working" : undefined}
			width={size}
			height={size}
			viewBox="0 0 256 256"
			fill={color}
			role="img"
			aria-label="Cubicle"
			xmlns="http://www.w3.org/2000/svg"
		>
			{QUARTERS.map((transform) => (
				<path key={transform ?? "base"} d={QUARTER} transform={transform} />
			))}
		</svg>
	);
}
