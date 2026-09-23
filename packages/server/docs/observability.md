# Diagnose a problem

Start with the failed response, then inspect the matching request and boot state. Keep the request ID, error code, hint, timestamp and exact URL when reporting a problem. Do not include setup codes, cookies or tokens.

## Find the relevant evidence

| What happened                               | Where to look first                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Passkey setup or login failed               | The UI's stage, error code and request ID; verify the browser URL matches `PUBLIC_ORIGIN` |
| An API request failed                       | Its response body and request ID, then authenticated `/_boot/events`                      |
| A reload failed or the app will not start   | Authenticated `/_boot/status`, boot events and process output                             |
| A message or extension action looks wrong   | `/api/events` and `/api/stream`, plus the extension's logs                                |
| Startup failed before HTTP became available | The terminal running chirp, or `docker logs chirp`                                        |

For `origin_invalid`, compare the full browser origin—scheme, hostname and port—with configuration. `localhost` and `127.0.0.1` are different. Check whether a reverse proxy changed the `Origin` header. See [deploying a board](../../../docs/deploy.md) for correct configuration.

Boot remains the diagnostic surface when editable app routes are unavailable. Read the returned recovery hint before retrying or changing files. Preserve journals and pending reservations; deleting evidence to force startup can put acknowledged data at risk.

## Read boot diagnostics

Use your existing authenticated browser session to open `/_boot/events`, or your enrolled agent's bearer token. Agent tokens need `read` scope. Humans and agents with `fs` scope read every request record, including anonymous ones; other agents read only their own. Private failure details additionally require a human session or `fs` scope.

`GET /_boot/events` accepts only these query parameters:

| Parameter | Meaning                                   |
| --------- | ----------------------------------------- |
| `since`   | Resume after a delivered sequence cursor  |
| `limit`   | Page size, 1–200; default 100             |
| `wait`    | Long-poll for up to 60 seconds; default 0 |

Without `since`, the response shows recent records. Read `items` and save the returned `cursor` after consuming the response. Continue with that cursor to inspect later records. Keep this boot diagnostics cursor separate from application feed cursors: recovery diagnostics can advance while app publication is blocked. Match a UI/API request ID against each event's `request_id` field locally; this endpoint does not accept request-ID or event-type filters.

Boot records `http.request` with the method, path, query parameters, user agent, status, generation, verified attribution, duration and outcome. Duration includes streaming and interruption, so a long-lived stream produces its completed record only when its HTTP scope ends. Application feeds deliberately omit these records: querying `/api/events` for them will not provide boot request diagnostics.

`query` lists up to 32 `[name, value]` pairs in request order, about 2 KB in total; `query_truncated` marks a cut. A value reads `[redacted]` when its name looks like a credential, such as `code`, `user_code`, `state`, `token`, `key`, `secret`, `password`, `signature`, `session` or `nonce`, or when the value contains a key- or token-like run of 20 or more characters mixing letter case or digits. The same check replaces such a parameter name. `client_id`, `redirect_uri` and `resource` skip the value check because OAuth makes them public. A nested URL query or fragment inside a value becomes `?[redacted]` or `#[redacted]`. Values and the user agent keep their first 256 characters. `error_code` appears only when boot itself refused the request; boot never reads app response bodies, so an app refusal shows only its status.

Request diagnostics use a bounded queue and may be dropped under load or storage failure; a later stored record then carries `lost`, the count of missing records. When the queue drains before another request is queued, boot writes the dropped count on its own as an `http.request` record with `outcome: "lost"`, `lost` and no request fields. Records are written when requests finish. A request that finished between two stored records is stored between them or counted in `lost` on a record after the first, up to and including the second. When neither holds and boot did not restart in between, boot did not finish that request. Boot never records `/health`, `/_boot/status`, `/_boot/events`, `/api/events` or `/api/stream`, and records still queued when boot stops are lost without a count. Use the API result and durable product/recovery evidence to establish whether a mutation committed.

## Add useful extension diagnostics

Use `ctx.log.set({ topic, message_id, lock_state })` to annotate the app handler span with relevant identifiers. The extension filename is added automatically. Values must use the supported bounded identifier characters. These annotations describe app execution; they are not added to boot's request record.

Effect Logger string messages become best-effort `log` events and sanitized NDJSON on stderr. Prefer a short description with a nonsecret identifier. Structured objects and causes are omitted from exported messages; a failure flag records whether a cause was present. Common credential assignments, bearer values and 64-digit hex strings are redacted, but arbitrary secrets in prose cannot be recognized reliably. Never log credentials.

The [optional event exporter](../pages/tooling/README.md) shows how to consume application events as NDJSON. Nothing is exported off-machine by default. Boot has no Prometheus registry or scrape endpoint; metrics presentation belongs in editable tooling. Current recovery traffic state is available at authenticated `/_boot/status`.

## Implementation notes

Boot creates its own Effect root span; public trace headers and baggage cannot choose that root. The authenticated child receives a private parent trace header. Its `http.app` span lasts until response construction. App/tooling owns export of its annotations: boot strips the legacy private response header without parsing or aggregating it. Annotations added after response headers commit cannot travel back through that header.

Both the serving boot runtime and installed app use scoped dropping queues of capacity 256 for Logger events. Overflow and failed writes are dropped without retries; logging is disabled in the drain to prevent recursion. The app drain serializes with lifecycle changes and does not publish during rehearsal or while frozen. Before the event graph exists, startup uses the runtime's default logger. NDJSON stderr excludes fiber annotations.

These diagnostics explain failures; they do not replace transactional records, publication receipts or recovery journals.
