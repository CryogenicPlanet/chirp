import { RefreshCw } from "lucide-react";
import { cn } from "../cn.ts";
import { Button } from "./button.tsx";
import { Tooltip } from "./tooltip.tsx";

/** The quiet refresh in a page header; live updates make it a fallback, not a primary action. */
export function RefreshButton({ loading, onClick }: { readonly loading: boolean; readonly onClick: () => void }) {
	return (
		<Tooltip content="Refresh">
			<Button variant="ghost" size="icon" className="size-9" onClick={onClick} disabled={loading} aria-label="Refresh">
				<RefreshCw className={cn(loading && "animate-spin")} />
			</Button>
		</Tooltip>
	);
}
