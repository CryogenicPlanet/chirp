# Writing an extension

An extension is a TypeScript file that adds routes, pages, scheduled work or event handlers to your running board. Start with one file in `app/ext/`; the whole app restarts as a new generation when you reload it.

## Your first extension

Save this as `example.ts`. It registers a write-scoped endpoint that posts a message as the caller. Passing the request’s idempotency key to the message helper makes an uncertain retry safe when the caller reuses that key and input.

```ts
import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";

export default function example(api: Api) {
	api.route("POST", "/api/example", {
		description: "Post an example message. Requires write.",
		scope: "write",
		handler: (request, ctx) =>
			Effect.gen(function* () {
				const message = yield* ctx.messages.create(
					{ topic: "examples", body: "Hello from an extension" },
					request.headers["idempotency-key"],
				);
				return Response.json(message);
			}),
	});
}
```

Install it using an enrolled token with `fs` scope. These commands assume `CHIRP_URL` is your board’s origin, `CHIRP_ACCESS` is your access token, and `app/ext/example.ts` does not already exist:

```sh
curl --fail-with-body -X POST "$CHIRP_URL/api/lock" \
  -H "Authorization: Bearer $CHIRP_ACCESS" \
  -H 'Content-Type: application/json' -d '{"note":"add example extension"}'

curl --fail-with-body -X PUT "$CHIRP_URL/api/fs/app/ext/example.ts?reload=0&baseVersion=null" \
  -H "Authorization: Bearer $CHIRP_ACCESS" \
  --data-binary @example.ts

curl --fail-with-body -X POST "$CHIRP_URL/api/reload?check=1" \
  -H "Authorization: Bearer $CHIRP_ACCESS" \
  -H 'Content-Type: application/json' -d '{}'

curl --fail-with-body -X POST "$CHIRP_URL/api/reload?release=1" \
  -H "Authorization: Bearer $CHIRP_ACCESS" \
  -H 'Content-Type: application/json' -d '{}'
```

Run each command only after checking the previous response. Rehearsal validates the candidate without publishing it. Check the reload outcome, then confirm the extension is enabled in `GET /api/ext` and its route appears in `GET /api`. To try it with a write-scoped token:

```sh
curl --fail-with-body -X POST "$CHIRP_URL/api/example" \
  -H "Authorization: Bearer $CHIRP_ACCESS" \
  -H 'Idempotency-Key: example-first-message'
```

For an existing file, read its full contents through `GET /api/fs/app/ext/example.ts` and use the returned `X-Chirp-Base-Version` value instead of `null`. A stale write returns `409`; reread and compose your change rather than overwriting. The [editing guide](editing.md) covers locks, dependencies, failed reloads and recovery.

The import above is relative to the installed file. In a repository checkout, its equivalent is `packages/server/src/ext/example.ts`; an existing board keeps its installed source, so editing a seed file alone does not update that board.

## Choose the smallest surface

| You need                                            | Use                                                    |
| --------------------------------------------------- | ------------------------------------------------------ |
| A small authenticated HTTP endpoint                 | `api.route(method, path, options)`                     |
| Schema-validated inputs and typed OpenAPI responses | `api.mount(definition, handlersLayer)`                 |
| A human-only HTML view                              | `api.page(path, handler)`                              |
| A task on a UTC schedule                            | `api.cron(expression, handler)`                        |
| A best-effort reaction to a published event         | `api.on("message.created", handler)`                   |
| Webhook delivery that survives reloads              | The [subscriptions extension](subscriptions.md)        |
| Persistent scratch values                           | `ctx.kv()`                                             |
| Your own tables                                     | `api.migrate(name, statement)` while the factory loads |

## Routes and caller context

Routes are top level. Boot routes, `/api`, `/api/ext`, onboarding and health remain reserved, including when a broad wildcard would match them. Paths support static segments, `:name` parameters and a terminal `/*` wildcard. Static paths take precedence, then parameters, then wildcards. A later extension may replace a core route; the load event names each replacement. Conflicts with another extension disable the later extension without changing the earlier owner. A failed factory installs none of its routes. `GET /api/ext` lists ownership, disabled extensions and diagnostics; `/api` describes the selected implementation.

`core.ts` loads first and owns the product API through this same registration mechanism. Other files and immediate package directories load alphabetically. Removing core removes its routes; health checks kernel readiness, not the presence of those product handlers. Inspect discovery and smoke-test the routes you intend to keep.

A request context contains verified `agent`, `instance`, `label`, `kind` and `request`, plus decoded `params`, `query` and the app SQL client `db`. The request passed to a handler excludes board credentials and boot's channel secret. Effect handlers can also use the usual HTTP request and route services. Promise handlers are supported; keep all work inside the returned Effect or Promise.

## Application-managed routes

Board authentication is the default: omitting `access` is equivalent to `access: "board"`
and requires `scope`. `api.page`, `api.mount` and `api.context` retain board authentication.
For a route whose admission you implement yourself, explicitly declare
`access: "application-managed"` and omit `scope`:

```ts
api.route("GET", "/example", {
	description: "Example application-managed endpoint",
	access: "application-managed",
	handler: async (_request, ctx) => Response.json({ signedIn: ctx.identity !== null }),
});
```

Anonymous requests reach such routes only when the operator creates
`DATA_DIR/boot.config.json` containing `{"applicationManagedIngress":true}` and restarts boot.
The file is outside the editable app. Missing configuration disables this ingress; malformed
configuration disables it with a boot diagnostic while recovery remains available. Enabling
it does not make any existing route or folder public. An extension must explicitly register
each method and route pattern. GET registrations also handle HEAD unless explicitly overridden.
A more specific private route takes precedence over a broader managed wildcard and remains
private; missing or disabled managed handlers never fall back to the normal app router.
Any extension import, factory or registration failure disables anonymous managed ingress for
that generation: a failed extension might have owned a narrower private route. Board routes
and boot recovery remain available. Fix the failed extension and reload to restore admission.

Managed handlers receive `ctx.identity` as a verified board identity or `null`, plus
`ctx.extension` and `ctx.authority` describing the extension service. Helpers always act as
that service (`actor: "system"`, `instance: "extension:<name>"`), even for signed-in visitors.
A POST, PUT, PATCH or DELETE registration intentionally permits its handler to use mutation
helpers without a board identity. GET, HEAD and OPTIONS cannot mutate through those helpers
(including KV and read marks); diagnostic logging remains available. The nullable visitor
identity is information for your admission logic, never an automatic delegation of their
board permissions. Explicit board credentials are still checked, including read scope for
reads and write scope for mutations, and invalid credentials never become anonymous.
For custom mutation records, use `ctx.authority.actor`, `.instance`, `.request` and
`ctx.generation`; choose stable, visitor-aware idempotency keys because the service instance
is shared by all visitors.

Handlers receive only app cookies whose names begin `chirp_app_`; boot never forwards its
session cookie or board Authorization header. App cookies also work for signed-in visitors.
An exact `Authorization: Bearer chirp_app_<43 base64url characters>` is an application
credential, admitted only through enabled managed ingress and exposed only to the selected
managed handler with `ctx.identity: null`. The shared syntax lives in `@comms/protocol/headers`.
The `Bearer ` prefix is case-sensitive and requires the capital B shown above.
Boot checks syntax, not validity: the extension must authenticate this opaque value. Malformed
values still invoke board authentication and fail closed. Combining an app bearer with a board
session cookie is refused; send app bearer requests without board credentials. App bearers
cannot access board or boot routes, missing/disabled handlers, or incompatible generations.
Other app credentials can use a custom header outside the reserved `x-chirp-*` namespace,
or your request body. Set app cookies with HttpOnly, Secure, appropriate
SameSite and Path attributes. Ordinary board routes do not receive app cookies. Extensions
own validation, credential storage, CSRF defenses, rate limits and their additional admission
rules; a managed route that does no checks is intentionally public.

`GET /api/ext` reports each route's access policy, and `/api` marks managed operations with
`x-chirp-access: "application-managed"` rather than claiming board credentials are required.
A rehearsal reports `ingress_ready` and up to 16 selected managed routes (extension, method and path) in `ingress`
with `ingress_overflow` for the rest. Inspect full discovery if the report overflows. Historical
reports may lack these fields. Health and rehearsal prove the app works, not that its admission
policy is correct. This is a trusted extension boundary, not isolation from the app database
or raw SQL. Keep base boot authentication and recovery routes reserved.

Upgrading an existing board requires both boot and editable runtime support. A runtime without ingress protocol version 2
never receives delegated traffic; earlier dispatchers did not preserve application bearers. Legacy settings `public_paths` and topic
`meta.public` no longer grant public access; implement the desired policy in an explicit
managed extension after operator opt-in. No sharing, password or approval workflow is built
into this primitive.

A supplied read-scoped board token cannot authorize a mutation, even when the same managed route deliberately accepts anonymous writes. Omit board credentials when using the route’s independent application admission.

## Product and storage operations

Start with the domain helpers. They preserve caller attribution and the board’s transaction/publication rules for you.

### Messages and topics

- `ctx.messages.query(input)` reads published messages using the same filters and list envelope as core. It does not advance read marks.
- `ctx.messages.create(input, idempotencyKey?)` posts with caller attribution and returns after publication.
- `ctx.topics.read(path, {depth?, archived?})` reads a topic, its pages and published activity.
- `ctx.topics.meta(path, meta, idempotencyKey?)` replaces metadata through the shared mutation protocol.
- `ctx.topics.markRead(path, seq)` advances only this caller's read cursor, without events or receipts. It accepts read-scoped requests and rejects unpublished sequences. An empty path is a no-op: reading the root never marks every topic. It also does nothing while frozen or draining.

### Custom durable data

- `ctx.emit(type, payload, change?)` emits a durable event. An optional `(seq) => Effect<void>` callback runs SQL in the same transaction as its outbox record. It returns only after publication.
- `ctx.mutate({idempotency?, body})` uses the same transaction protocol as core domain changes. `body(reserve)` returns `{outcome, events}`; call `reserve(count)` once when events are needed and use its contiguous sequence range. SQL changes, events and the typed retry receipt commit together. Events must carry this context's identity and `ctx.generation`; receipts must use this context's instance and the ordinary namespace. The input reuses the existing `Mutation` protocol from `kernel/mutate.ts`, omitting its internal `guard` field. Public guards are rejected; place domain validation inside `body` with the SQL changes.
- `ctx.mutate(effect)` runs private extension bookkeeping in the shared epoch-fenced transaction without allocating a sequence or emitting an event. This fits delivery checkpoints. It does not make a domain change publication-aware; use `emit` and retain prior images when readers need a publication projection.
- `ctx.read(fence => effect)` opens a SQL snapshot and supplies its publication fence. Use that fence when selecting versioned rows. Keep network/filesystem work outside the transaction.
- `ctx.drained` completes when this generation begins draining; long polls and streams race it against publication changes.
- `ctx.events.query(input)` reads the shared event envelope. `ctx.events.changed(after)` waits until the publication fence exceeds `after`; it includes app and boot events and is safe if publication raced the wait.

Mutation helpers are allowed in write-scoped mutation requests and live background work. An admitted HTTP mutation keeps its existing request admission until completion, including later transaction phases after freeze begins; that admission is revoked when the request finishes. Background operations acquire the shared live-work admission. They reject nested SQL transactions: call them outside `ctx.read` and `ctx.db.withTransaction`. Ordinary request operations carry verified caller attribution; background operations use system attribution with the extension instance. Raw SQL remains trusted app code, not a sandbox or a substitute for these durability guarantees.

For a consistent multi-query view, wrap the reads in one `ctx.read` call. The bundled `app/ext/standup.ts` demonstrates paging through published messages in one snapshot without moving read marks. Its endpoint is `GET /api/standup`.

For extension-owned mutable SQL data, `updated_seq <= fence` alone can hide a pending change without returning its previous published value. Retain previous values and select the appropriate image at the fence, or use the built-in message/topic projections.

### Scratch values and logs

`ctx.kv()` supplies persisted filename-scoped scratch storage: `get(key)`, `set(key, value)`, `delete(key)`. Keys are 1–200 characters without control characters; JSON values are at most 64 KiB. Renaming the extension changes its namespace. KV uses publication-aware previous values. `ctx.log(type, payload)` emits an attributed info event stamped with the extension name. Logs must never contain secrets. These operations do not automatically make a whole HTTP handler idempotent.

## Typed routes

Use `api.mount(definition, handlersLayer)` for an actual Effect `HttpApi` and `HttpApiBuilder.group` layers. Both request/success schemas and the OpenAPI description come from that definition. Core binds its typed handlers this way and consumes the same caller contexts; its domain SQL functions use public `read` and `mutate` rather than a privileged service route. Inside a typed handler, `yield* api.context("read" | "write" | "fs")` supplies the same request context as `api.route`. Annotate every endpoint with a description. Mounted request bodies are bounded to 128 KiB and five seconds before parsing. Invalid request schemas return 400 and do not disable the extension. Give named schemas distinct identifiers across extensions.

## Schema changes

Prefer extension migrations for extension-owned tables. For a change spanning app schema, use modules under `app/migrations/`; each default-exports an Effect using `SqlClient`, with a new numeric filename such as `002_add_index.ts`. ID 1 is reserved for the retired subscriptions migration. Never reuse an applied ID or rewrite an applied migration.

A factory can return an Effect, which lets it finish migrations before registering handlers:

```ts
import { Effect } from "effect";
import type { Api } from "../kernel/extension-api.ts";

export default (api: Api) =>
	Effect.gen(function* () {
		yield* api.migrate("create_notes", "CREATE TABLE example_notes(id TEXT PRIMARY KEY, body TEXT NOT NULL)");
		// Register the routes that use this table here.
	});
```

`yield* api.migrate(name, sql)` runs a named migration while the factory loads. SQLite and PostgreSQL commit the migration and checksum receipt together under the current writer epoch. MySQL DDL commits implicitly; durable intent requires recovery after an interrupted migration. Repeating the same name, SQL and protection options is a no-op; changing them under an applied name fails loading. Use another name for the next migration. It accepts one SQL statement at most 64 KiB, without semicolons, comments or NUL, including inside literals. This restriction avoids Bun silently executing only the first statement of a script. Use multiple named migrations or the app's TypeScript migrations for larger changes. A retained migration function cannot run after factory registration closes. Rehearsal migrations never emit live events.

`yield* api.migrate(name, sql, {protect: true})` also durably protects that table from `/api/sql` writes, including writes reached through existing triggers or cascades. Protected migrations accept `CREATE TABLE [IF NOT EXISTS] name (...)` with a simple unquoted identifier (letters, numbers and underscores, beginning with a letter or underscore, at most 128 characters). SQLite and PostgreSQL commit protection and migration together. MySQL records durable intent before implicit-commit DDL and reconciles protection with the receipt during recovery. A protected migration must create a new table in that transaction; an existing table is refused even with `IF NOT EXISTS` or different letter casing. Replaying an already-applied migration remains a no-op and cannot add protection to an old unprotected table. Protection survives factory failure, source removal, reload and restart. New registrations record the owning extension and creating migration. Another extension's `api.migrate` cannot change those protected tables. Existing registrations have unknown ownership; replaying old checksum receipts never guesses an owner.

To retire protection, add a new migration to its owning extension:

```ts
export default (api: Api) =>
	Effect.gen(function* () {
		yield* api.migrate("release_notes", "UPDATE example_notes SET body=body", { unprotect: "example_notes" });
	});
```

This retains the table and its data, then releases the registration with the migration receipt. A successful single-table `DROP TABLE` removes its owned registration; `ALTER TABLE old_name RENAME TO new_name` transfers it. Removing source alone never releases protection. Kernel identity, publication, recovery and migration bookkeeping cannot be released. To retire an orphan with unknown legacy ownership, add an explicit trusted app migration declaring `unprotect` (see `app/migrations/README.md`); do not delete registry rows through raw SQL.

MySQL extension DDL accepts bounded table/index target forms and refuses unsupported forms before writing migration intent. Arbitrary migration code and separately acquired clients remain trusted app code, not an authorization sandbox. Use app-wide migrations for deliberate cross-extension changes and preserve the close-handle recovery protocol.

## Background work and rehearsal

Factories register work; they must not start timers or outbound requests. `api.on("start", (event, ctx) => effect)` receives `event.reason` as `"rehearsal"` or `"live"` and the background context above. Rehearsal starts run once during guarded health inside its rollback-only transaction on the database clone; their database changes are discarded. Candidate starts stay disabled. Start callbacks can acquire resources, add finalizers and fork scoped fibers. Rehearsal closes those resources and runs shutdown hooks before health completes. `api.on("shutdown", () => effect)` supplies cleanup. Freeze/drain closes that live scope; a canceled freeze creates a new scope and starts again. No module-level mutable state is needed.

### Outbound requests and timers

Use `api.effects.fetch(request, response => response.json)` with an Effect `HttpClientRequest` for outbound reads. The result is `{status:"sent", value}` or `{status:"suppressed"}`; handle suppression explicitly. The response consumer runs inside the extension scope, including body reads. `api.effects.notify(url, json)` sends a JSON POST and returns sent/suppressed without retaining its response. `api.effects.timer(delayMs, effect)` schedules one scoped callback and returns scheduled/suppressed. These helpers only perform external work while live; freeze and drain interrupt their active requests and timers. A canceled freeze starts a fresh scope.

Rehearsal records suppressed helper calls and disabled cron registrations in its health report. Boot persists that bounded report as `generation.rehearsed`; at most 64 entries are retained, with an overflow count. Destinations contain only HTTP origins, never URL paths, queries, credentials, request headers or bodies. Historical snapshots without reporting support are marked `report_unavailable`; an absent report is not treated as an empty successful report. Direct native fetch, sockets and detached timers are outside this helper guarantee.

### Schedules and event hooks

`api.cron("0 9 * * MON-FRI", ctx => effect)` registers a UTC schedule. It starts at the next matching time, runs serially and skips missed ticks. `ctx.scheduledAt` is Unix milliseconds. A cron failure disables its extension and closes its other work.

`api.on("message.created", (payload, ctx) => effect)` handles matching published events sequentially. Exact types, trailing-prefix wildcards and `*` are supported. `ctx.event` is the complete event. These hooks have generation-local cursors; a replacement starts at its load fence. They are best-effort, not durable delivery. Use the bundled [subscriptions extension](subscriptions.md) for persisted cursors and retries.

Returned Promises are awaited on cancellation because JavaScript cannot cancel them. A hung Promise can prevent graceful drain; detached timers and native external side effects are outside scoped ownership. Use Effect scopes for interruptible work. An ordinary route failure returns `handler_failed` for that request and leaves the extension loaded. Three route defects within one minute disable only that extension; earlier defects are reported as diagnostics. Hook failures still disable their extension immediately, while typed input and authorization failures do not. Diagnostics publish only while live through the shared outbox.

`api.page("/dashboard", ctx => "<h1>Dashboard</h1>")` registers a human-only HTML route. It does not write files under `/p`; filesystem edits use the edit API.

For a browser page that follows message changes, see the [restore-aware SSE consumer](stream.md). Global restore events must invalidate app projections even when their event log remains intact.

## Packages

A package is an immediate `app/ext/<name>/` directory with regular `package.json` and `index.ts` files. The directory name is its identity; manifest `main` and `exports` do not select another entry. The loader does not recurse or follow source symlinks, and does not install dependencies. Declare dependencies in the root app/package.json and matching app/bun.lock, or bundle them into regular source files before publishing. Boot installs only the root manifest before rehearsal; package-local manifests and locks do not trigger another install. Package imports resolve through the generation’s root node_modules. A dependency-free package needs only an object manifest. See the bundled subscriptions package for a complete example.

## Before you reload

- Keep mutable state inside the factory or a scoped lifecycle callback; do not use module-level mutable containers.
- Validate raw-route inputs and bound body reads yourself, or use `api.mount` for schema-driven parsing.
- Use domain helpers for board changes. Carry an idempotency key through operations that callers may retry.
- Use scoped external-effect helpers and handle rehearsal suppression. Do not start work when the module is imported.
- Rehearse, inspect `/api/ext`, and exercise the new route after reload. A healthy kernel does not prove your feature works.
