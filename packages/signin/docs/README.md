# @comms/signin

The issuer behind `https://auth.chirp.wiki`. It lets a person sign in to any chirp board, self-hosted or Cloud, with GitHub or Google, and hands the board a short-lived signed ID token saying who they are. Boards decide what that identity may do; this service only vouches for it.

It is an OpenID Connect provider for public clients. A board needs no registration: its `client_id` is the URL of its [Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/), `<board origin>/auth/oidc/client.json`, which lists the board's redirect URIs.

Nothing is stored. The browser carries the sign-in in a sealed `__Host-signin.tx` cookie (AES-256-GCM, 10 minutes) and a sealed session cookie per provider (30 days), a code is the sealed grant itself (60 seconds), and the only memory is the set of redeemed code ids until they expire.

## A sign-in

1. The board sends the browser to `/authorize` with its `client_id`, `redirect_uri`, `state`, `nonce`, an S256 `code_challenge` and `provider=github|google`.
2. The issuer fetches the board's client document and checks the `redirect_uri` against it. Until that succeeds every error is a page here; nothing redirects to an unchecked address. After it, errors go back to the board as `error`, `state` and `iss`.
3. With a live [session](#sessions) for that provider, the issuer answers for the person: a board they approved gets its code at once, as in step 5, and any other board gets the question in step 4. Otherwise the browser signs in at GitHub or Google. The issuer uses its own `state` and PKCE upstream, never the board's.
4. On return, the issuer reads the account and asks, once per board: "Sign in to `<board origin>` as `<account>`?" When the `client_id` is on another origin than the `redirect_uri`, the question also names it: "Sign in to `<board origin>` (registered by `<client_id host>`) as `<account>`?", because the ID token's audience is the `client_id`. GitHub accounts are identified by numeric id, with the login as a label. Google accounts are identified by `sub`, with the email only when Google reports it verified.
5. Continue redirects to the board with `code`, `state` and `iss`, and remembers the board in the session. Cancel redirects with `error=access_denied` and remembers nothing.
6. The board posts the code and its PKCE verifier to `/token` and receives an ES256 ID token valid for 5 minutes, verifiable against `/jwks.json`.

## Sessions

Continue writes a sealed `__Host-signin.github` or `__Host-signin.google` cookie (HttpOnly, Secure, SameSite=Lax so it rides a board's redirect) holding the account, when it signed in at the provider, and up to 64 approved boards, newest first. A board is its `client_id` and redirect origin, so a client document that adds an origin is asked again. The session ends 30 days after the provider sign-in; using it never extends it, and every ID token it yields carries that sign-in's `auth_time`. Each provider has its own cookie, so a GitHub sign-in never forgets the boards approved with Google. `/signout` ends both.

The session is as stateless as the rest of the service:

- Nothing on the server can revoke it. Only `/signout` in that browser, or replacing the seal key for everyone, ends it early.
- A stolen cookie signs in as its owner, and can approve new boards, for up to 30 days.
- A GitHub or Google account that is suspended or deleted keeps signing in until its session ends, up to 30 days.

The OpenID Connect `prompt` and `max_age` parameters are ignored, so a board cannot force a fresh provider sign-in or a consent page; a board that wants a recent sign-in can check `auth_time`.

## Routes

`GET /` lists every route with its description; the table is `src/routes.ts`.

| Route                                          | Purpose                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/openid-configuration`        | Provider metadata.                                                                                              |
| `GET /jwks.json`                               | The public signing key.                                                                                         |
| `GET /authorize`                               | Start a sign-in. A session answers without the provider.                                                        |
| `GET /callback/github`, `GET /callback/google` | Upstream returns here; shows consent.                                                                           |
| `POST /consent`                                | The consent form. Requires `Origin` equal to the issuer and the page's CSRF token. Continue writes the session. |
| `GET /signout`                                 | The sign-out page.                                                                                              |
| `POST /signout`                                | Ends both sessions and any sign-in in progress. Requires `Origin` equal to the issuer.                          |
| `POST /token`                                  | Exchange a code (form-encoded, PKCE, no client authentication).                                                 |
| `GET /health`                                  | Liveness.                                                                                                       |

ID token claims: `iss`, `aud` and `azp` (both the `client_id`), `sub` (`github:<id>` or `google:<sub>`), `iat`, `exp`, `nonce`, `auth_time`, `chirp_provider`, and `preferred_username` (GitHub) or `email` (verified Google only).

## Client documents

A `client_id` must be canonical `https` with a path and no query, fragment, userinfo or IP-literal host. The issuer resolves the host and refuses it if any address is private, loopback, link-local, unique-local (which includes Fly's `fdaa::/16` 6PN) or otherwise special-use. It then connects to the checked address, keeping the hostname for SNI and the certificate, so DNS rebinding cannot redirect the fetch. It follows no redirects, reads at most 8 KB and gives up after 3 seconds. The document's `client_id` must equal its URL, `token_endpoint_auth_method` must be `"none"`, and the `redirect_uri` must appear exactly in `redirect_uris` and be `https`. Documents are fetched on every `/authorize`, never cached.

## Environment

| Variable                                   | Value                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `SIGNIN_ISSUER`                            | `https://auth.chirp.wiki`. An origin with no path; `http` only on localhost. Set in `fly.toml`. |
| `SIGNIN_SIGNING_KEY`                       | ES256 private JWK with a `kid`, from the keygen script. Secret.                                 |
| `SIGNIN_SEAL_KEY`                          | 32 bytes as 64 hex characters, from the keygen script. Secret.                                  |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | The GitHub OAuth app. The secret is secret.                                                     |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google OAuth web client. The secret is secret.                                              |
| `PORT`, `HOST`                             | Listener, default `8080` and `127.0.0.1`. The image sets `HOST=0.0.0.0`.                        |

The service checks every value at startup and refuses to start on a bad one, naming the variable but never printing its value. The request logger is off because query strings carry codes, `state` and `nonce`.

## Keys

```sh
bun run --filter @comms/signin keygen
```

prints `SIGNIN_SIGNING_KEY=<JWK>` and `SIGNIN_SEAL_KEY=<hex>` lines, ready for `fly secrets import`. The `kid` is the key's RFC 7638 thumbprint. Never commit the output.

There is no rotation tooling. Replacing the signing key invalidates ID tokens issued in the last 5 minutes; boards refetch the JWKS when they see the new `kid`. Replacing the seal key fails sign-ins in progress and unredeemed codes, and ends every session.

## Setting up auth.chirp.wiki

Run these once, from the repository root, as the Fly account that owns `chirp-cloud` (org `personal`).

1. Create the app: `fly apps create chirp-signin --org personal`.
2. Stage the keys: `bun packages/signin/scripts/keygen.ts | fly secrets import --stage --app chirp-signin` (through `bun run --filter`, each line gains a package prefix that `fly secrets import` rejects).
3. GitHub: in [Developer settings → OAuth Apps](https://github.com/settings/developers), create an OAuth app (not a GitHub App) with Homepage URL `https://auth.chirp.wiki`, Authorization callback URL `https://auth.chirp.wiki/callback/github` and device flow off, then generate a client secret. Or reuse an existing OAuth app: add that callback URL alongside its others and copy its client id and secret. Then `fly secrets set --stage --app chirp-signin GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=…`. The app requests no scopes; it reads only the public profile. An app shared with another service issues tokens carrying the scopes users already granted that service; the issuer makes one `/user` call with the token and then discards it.
4. Google: in the [Google Auth Platform](https://console.cloud.google.com/auth/overview) for a project you own, configure the consent screen: app name `chirp`, a support email, authorized domain `chirp.wiki`, audience External, and data access scopes `openid` and `.../auth/userinfo.email`. Publish it to production so any Google account can sign in; these are non-sensitive scopes, so they need no scope verification review. Then under Clients create a Web application client with Authorized redirect URI `https://auth.chirp.wiki/callback/google` and no JavaScript origins, or reuse an existing web client: add that redirect URI alongside its others and copy its client id and secret. Then `fly secrets set --stage --app chirp-signin GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=…`.
5. Deploy once by hand: `fly deploy --config packages/signin/fly.toml --dockerfile packages/signin/Dockerfile --ignorefile packages/signin/Dockerfile.dockerignore --depot --ha=false`. Keep it to one machine: redeemed codes are tracked in that process.
6. Certificate and DNS: `fly ips allocate-v6 --app chirp-signin`, `fly ips allocate-v4 --shared --app chirp-signin`, then `fly certs add auth.chirp.wiki --app chirp-signin`. In Cloudflare DNS for `chirp.wiki`, add the records `fly certs show auth.chirp.wiki --app chirp-signin` asks for (an `A` and `AAAA` for `auth`, or a `CNAME auth → chirp-signin.fly.dev`) with proxy status **DNS only**, so Fly terminates TLS. Wait until `fly certs check auth.chirp.wiki --app chirp-signin` reports the certificate issued.
7. Continuous deploys: `fly tokens create deploy --app chirp-signin`, saved as the repository secret `FLY_SIGNIN_API_TOKEN`. After that, a master push that passes the `Signin` workflow deploys through `Deploy Signin`. Until the secret exists, `Deploy Signin` succeeds without deploying and leaves a notice saying so.
8. Check: `curl https://auth.chirp.wiki/.well-known/openid-configuration` shows `"issuer":"https://auth.chirp.wiki"`, and `curl https://auth.chirp.wiki/jwks.json` shows one key.

## Limits

- One machine. A second machine, or a restart within a code's 60 seconds, could let a code be redeemed twice; it would still need the board's PKCE verifier, and the board consumes its own state once.
- No rate limiting.
- Boards under `*.boards.chirp.wiki` are same-site with auth.chirp.wiki and can set `Domain=chirp.wiki` cookies. `__Host-` stops them from replacing the transaction and session cookies but not from crowding the cookie header. Browsers skip the `__Host-` rules for a name with a leading non-breaking space, so the issuer trims only spaces and tabs and reads such a cookie as another name; the Public Suffix List entry that would end this is deferred.
- A local board on `http://localhost` cannot use auth.chirp.wiki: the issuer only fetches public `https` client documents. Tests reach loopback `http://localhost` and `https://localhost` document servers through `loopbackLayerForTests` in `src/client-metadata.ts`, which `main.ts` never uses.

## Tests

```sh
bun run --filter @comms/signin test
```

They run the service in process against fake GitHub and Google servers and a loopback client document server. Two parts run under Bun, because vitest runs on Node and Node ignores Bun's fetch `tls` options and `Host` override: `src/main.ts` is launched once to check the production wiring and that secrets stay out of its output, and the pinned client-document fetch runs against `https://localhost` servers whose certificates come from a throwaway CA trusted through `NODE_EXTRA_CA_CERTS`. Those certificates are made with `openssl` during the test.

## Specifications

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html): ID token claims, `nonce`, `azp`, `auth_time`.
- [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749) and [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636): the code grant and PKCE S256.
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207): `iss` on every authorization response.
- [OAuth Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/).
- [GitHub OAuth app web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) and [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
