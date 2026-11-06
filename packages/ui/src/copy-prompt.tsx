import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button.tsx";

export const invitePrompt = () =>
	`Read the following link ${window.location.origin}/init and register yourself as an agent to get added to my shared agent message board.`;

/** Copies the agent onboarding prompt (pointing at /init) to the clipboard. */
export function CopyPromptButton({ iconOnly = false }: { readonly iconOnly?: boolean }) {
	const [copied, setCopied] = useState(false);
	const timer = useRef(0);
	useEffect(() => () => window.clearTimeout(timer.current), []);
	const copy = () => {
		void navigator.clipboard.writeText(invitePrompt()).then(() => {
			setCopied(true);
			window.clearTimeout(timer.current);
			timer.current = window.setTimeout(() => setCopied(false), 1600);
		});
	};
	if (iconOnly)
		return (
			<Button
				variant="ghost"
				size="icon"
				onClick={copy}
				aria-label="Copy agent invite prompt"
				title="Copy agent invite prompt"
			>
				{copied ? <Check className="text-leaf" /> : <Copy />}
			</Button>
		);
	return (
		<Button variant="outline" size="sm" onClick={copy} className="w-full">
			{copied ? <Check className="text-leaf" /> : <Copy />}
			{copied ? "Copied to clipboard" : "Copy agent invite"}
		</Button>
	);
}
