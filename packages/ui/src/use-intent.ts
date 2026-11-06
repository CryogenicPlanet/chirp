import { useEffect, useRef } from "react";

/** Calls `act` when a click looks likely: the pointer rests on the element, keyboard focus reaches it, or a finger touches it. */
export function useIntent(act: () => void, delay = 120) {
	const timer = useRef(0);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const start = () => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(act, delay);
	};
	const stop = () => window.clearTimeout(timer.current);
	// Touch has no hover: a finger going down is the earliest sign of a tap, so act at once.
	const now = (event: { readonly pointerType: string }) => {
		if (event.pointerType !== "mouse") act();
	};
	return { onPointerEnter: start, onPointerLeave: stop, onPointerDown: now, onFocus: start, onBlur: stop };
}
