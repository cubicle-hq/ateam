// Cubicle brand mark (four I-beam quarters around a star-shaped gap), inlined so it
// works under the app's CSP and offline — never hotlinked. Defaults to Cubicle's copper;
// pass "currentColor" to draw it in the surrounding text colour (e.g. on a copper button).
const QUARTER =
	"M24 20H118Q122 20 122 24V118Q122 122 118 122H24Q20 122 20 118V117Q20 113 24 113H70V84Q70 58 44 58H24Q20 58 20 54V24Q20 20 24 20Z";

export function CubicleLogo({
	size = 16,
	color = "#BC5F35",
}: {
	size?: number | string;
	color?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 256 256"
			fill={color}
			role="img"
			aria-label="Cubicle"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d={QUARTER} />
			<path d={QUARTER} transform="matrix(-1 0 0 1 256 0)" />
			<path d={QUARTER} transform="matrix(1 0 0 -1 0 256)" />
			<path d={QUARTER} transform="matrix(-1 0 0 -1 256 256)" />
		</svg>
	);
}
