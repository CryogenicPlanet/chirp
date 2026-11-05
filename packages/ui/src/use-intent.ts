import { useEffect, useRef } from "react";

/** Calls `act` once the pointer rests on (or keyboard focus reaches) an element for a moment: a likely click. */
export function useIntent(act: () => void, delay = 120) {
	const timer = useRef(0);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const start = () => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(act, delay);
	};
	const stop = () => window.clearTimeout(timer.current);
	return { onPointerEnter: start, onPointerLeave: stop, onFocus: start, onBlur: stop };
}
