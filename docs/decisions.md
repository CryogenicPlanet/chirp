# Decisions

The owner's later rulings, verbatim and dated. A selection records the question put to the owner, the option chosen, and the description shown with it. Add entries only as a quotation or a selection; never add prose here.

## 2026-09-12 — Moving a board between engines

> yeah i don't think we need the transfer tool.

## 2026-09-12 — The board's UI

> i would like to be able to see the board idc about code size for that react ui and shit its whatever.

## 2026-09-12 — What belongs in the bootloader

> idc about a specific line budget but i really care if the bootloader is doing more than it should be like if we are applying max scrutiny to does this need to be in the bootloader

## 2026-09-12 — The spec

> i think we need to audit the spec more deeply and probably delete a lot and probably move to a higher level product spec than such a detailed spec where the intent is lost in the semantics

## 2026-09-12 — Documentation folder

> this docs folder is not human docs as much as like docs for you to align yourself so in that case they don't need to be there at all

_Superseded 2026-09-21._

## 2026-09-13 — Several domains per board

> can we spin up a sub agent to make this easier, like you can have multiple domains and generate a code inside the dashboard to add a new passkey

> yeah this is the correct workflow ig also like when generating the code you can add a domain there that add its to the RP_ID or whatever

## 2026-09-13 — A passkey that matches no domain

Asked: If no passkey works on any of the board's domains (for example after a mistyped RP_ID), what should chirp do?

Selected: Serve and warn (Recommended)

Shown: Keep the board and agents running. Log the problem on every start, show a clear hint on the sign-in page, and flag it publicly. Invalid settings still refuse to start.

## 2026-09-13 — Getting back in

Asked: If you're locked out of every passkey, how should you get back in?

Selected: Add REOPEN_SETUP=1 (Recommended)

Shown: An operator-only Railway variable that reopens /setup with a code in the logs and adds a passkey without deleting existing ones. No shell or SQL needed.

## 2026-09-13 — Proving a new domain

Asked: When a code names a new domain, how should chirp confirm the domain really serves this board?

Selected: Board fetches a nonce (Recommended)

Shown: Before activating, chirp requests a one-time value from https://&lt;domain&gt;/... itself. Blocks typos and domains that don't point at the board, even if a code leaks.

## 2026-09-13 — Liveness

Asked: /health always returns a hard-coded ok with mode local-development, even when boot has failed. What should happen?

Selected: Report real state, follow-up (Recommended)

Shown: Keep 200 so recovery stays reachable on Railway, report boot's actual state and a degraded flag, and drop the local-development label. Done as a separate change after the passkey branch.

## 2026-09-17 — Application-managed ingress

> yeah so ig a config file to allow application managed ingress make sense and i would say the base auth shouldn't fully be editable but you can add whatever new stuff you want

> if someone really wanted to add an annonymous writer not sure we should prevent them just shouldn't happen by mistake

## 2026-09-18 — MCP

> so initially i was sorta against adding a base mcp to chirp but i think now have a basic MCP makes sense to connect to things like normie chatgpt and people of course can build it themselves so maybe what we do is we build a nice example extension for a good mcp with passkey oauth and 80/20 feature set that is stateless and such
>
> and then user can tell their clanker to enable it if they want

> the entire /mcp should be an extension right?

> that is the point

> the goal of this PR was to make a good example of a /mcp route and if needs some auth stuff it should look into building on top of #21 or if something is missing from #21 then #21 should add that too
>
> it should definitely not add any code to the bootloader

## 2026-09-21 — Canonical documentation

> yeah so i am thinking we just sorta nuke spec and we move everything into docs i like docs/product-intent cause it is my words simply where in spec i need to be really careful about any line you write that becomes canonical by mistake
