import { expect, it } from "vitest";
import { pageMarkdown } from "../src/page-markdown.ts";

it("gives headings GitHub-style ids from their visible text", () => {
	const render = pageMarkdown();
	const page = render(
		"# <em>Setup</em>\n\n## Setup\n\n## &#65;pproval &amp; trust\n\n## Chirp palette\n\n## `code` *here*",
		"guide.md",
	);
	expect(page).toContain(`<h1 id="setup"><em>Setup</em></h1>`);
	expect(page).toContain(`<h2 id="setup-1">Setup</h2>`);
	expect(page).toContain(`<h2 id="approval--trust">`);
	// The page palette mounts on this id, so a heading can't take it.
	expect(page).toContain(`<h2 id="chirp-palette-1">`);
	expect(page).toContain(`<h2 id="code-here">`);
	// Ids start over on each page.
	expect(render("# Setup", "other.md")).toContain(`<h1 id="setup">`);
});
