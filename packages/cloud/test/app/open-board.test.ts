import { expect, test } from "vitest";
import { openBoardTarget } from "../../src/app/open-board.ts";

test("Open board follows only the board's own setup or sign-in page", () => {
	const host = "quiet-robin-a3f2.boards.chirp.wiki";
	for (const url of [
		`https://${host}/setup#code=A1B2C3D4E5F60718`,
		`https://${host}/auth/login?provider=github&next=/`,
	])
		expect(openBoardTarget({ url }, host)).toEqual({ navigate: url });
	expect(openBoardTarget({ fallback: "setup_code" }, host)).toEqual({ setupCode: true });
	for (const value of [
		{ url: "https://evil.test/setup#code=x" },
		{ url: `https://${host}.evil.test/auth/login` },
		{ url: `https://${host}:8443/auth/login` },
		{ url: `https://user@${host}/auth/login` },
		{ url: `http://${host}/auth/login` },
		{ url: `https://${host}/api/tokens` },
		{ url: "javascript:alert(1)" },
		{ url: "/auth/login" },
		{ fallback: "elsewhere" },
		null,
	])
		expect(openBoardTarget(value, host)).toBeUndefined();
});
