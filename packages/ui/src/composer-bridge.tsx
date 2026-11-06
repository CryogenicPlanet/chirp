import { createContext, useContext } from "react";

/** Lets a message's Reply action reach the composer on the same view. Null where there is no composer. */
export interface ComposerBridge {
	readonly reply: (reply: {
		readonly agent: string;
		readonly label: string | undefined;
		readonly seq: number;
		readonly topic: string;
	}) => void;
}

export const ComposerBridgeContext = createContext<ComposerBridge | null>(null);
export const useComposerBridge = () => useContext(ComposerBridgeContext);
