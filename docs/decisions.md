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

## 2026-10-12 — What to work on next

> let's iterate on chirp product experience
>
> here are the things i would like to tackle
> - making mcp very good, mcp events, very powerful mcp (loop with dot if you need real testing)
> - normal oauth outside just passkeys for boards -> need to set a passkey first then can add oauth
> - on cloud pass through oauth where i can share the logins (will need some work, between cloud and the board)
> - cloud mcp -> will become a chatgpt plugin, if you don't have board will make one for you and you can choose your cloud board and everything

## 2026-10-12 — Extensions that act as agents

> i guess we should just make mcp first party then huh? i really didn't want to do this and wanted to have a really powerful extension system that can support things like mcp as extensions

Asked: How should an extension such as MCP get the editing powers a board agent has: (a) the extension mints and holds an agent token itself, or (b) a boot primitive?

Selected: (b) A proper boot primitive: extension grants

Shown: You approve with your passkey that "extension `mcp` may act as agent `dot` with scopes read/write/fs". Boot stores that grant. The extension then calls the board API over boot's internal channel, naming the grant instead of presenting a token. Boot checks that the grant is live, enforces its scopes and attributes the call to `dot`. The app never holds a credential. Grants show up and can be revoked in boot's account page, next to tokens. Any extension can use it, not just MCP. It is boot code, but it's credential code, which is boot's job. It isn't MCP code, so it doesn't conflict with your 09-18 ruling.

> i prefer b

## 2026-10-12 — fs through an extension grant

Asked: Can a grant include fs (pages, app source)? Page publishing needs it.

Selected: Allowed, off by default (Recommended)

Shown: The approval page has an fs checkbox that starts unticked. You tick it for dot.

## 2026-10-12 — Live reload through an extension grant

Asked: Should v1 let dot reload app source (live edit), or only edit messages, pages and topics?

Selected: Include detached reload (Recommended)

Shown: dot can lock, stage and reload. Boot runs the reload in the background and returns 202, so it can't deadlock on dot's own call. About one more day of work.

## 2026-10-12 — Extension grant lifetime

Asked: How long should a grant last?

Selected: 90 days, then re-approve (Recommended)

Shown: Same as long-lived agent tokens. connection_info shows the expiry, and MCP asks for re-approval when it lapses.

## 2026-10-12 — One extension grant per connection

Asked: One grant per MCP connection, or one shared by every connection posting as the same name?

Selected: One per connection (Recommended)

Shown: Each ChatGPT or Claude connection is its own agent family, so revoking one leaves the others alone. There may be more rows on the Agents page.

## 2026-10-13 — Simpler chirp for others

> i think we need to simply chirp usage for others so should hand roll some stuff that make sense and let other things be quite customizable

## 2026-10-13 — One sign-in service for every board

> so the problem we will have with oauth is that each self deployed board will have to gets its own client id, client secret and quite annoying so i wonder if we can make a nice auth.chirp.wiki which works for both self hosted boards like chirp.cryo.wtf and for cloud boards too

> yes let's build auth.chirp.wiki for github and google

## 2026-10-13 — Naming each MCP client

> i like dot@codex where the @ is ghe user agent

## 2026-10-13 — Where linked identities are stored

Asked: How should boot store linked GitHub/Google identities?

Selected: Existing tables (Recommended)

Shown: Linked identities go in boot's settings table and sign-in state in auth_challenges. No schema step, so a rollback is just swapping the image back. The cost: sessions don't record how they were opened, so unlinking signs out every other session, and GitHub sessions can't be given fewer rights later without a migration.

## 2026-10-13 — What a GitHub or Google sign-in can do

Asked: What can a GitHub/Google sign-in do on a board?

Selected: Same as passkey (Recommended)

Shown: Read, post and fs, like a passkey session. Anything that already needs a fresh passkey still does. Risk: someone who steals your GitHub account could edit the app through fs, and use that to trick your next passkey prompt.

## 2026-10-13 — Consent on every sign-in

Asked: Should auth.chirp.wiki ask for consent on every sign-in?

Selected: Every time (Recommended)

Shown: One extra click. Without it, any website could quietly send a visitor through auth.chirp.wiki and learn their GitHub identity, because GitHub approves silently after the first time.

_Superseded 2026-10-25._

## 2026-10-25 — Sign-in that works across Cloud and boards

> idk that is still a bit jank of a user experience for users right hard to explain all that i think it should just work across

## 2026-10-26 — Reusing Cloud's OAuth apps for auth.chirp.wiki

> what is this new secret you want? like just use the old github and google creds will just update the urls once you make the change on cloud login to work with this auth service

> actually github also supports multiple redirect uri now so the cloud chirp should be fine too
