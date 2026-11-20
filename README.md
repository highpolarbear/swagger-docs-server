# Swagger docs server with MCP

A standalone, design-first API docs server written in TypeScript (Node.js + Express). One container serves:

| URL             | What                                              | Access                       |
|-----------------|---------------------------------------------------|------------------------------|
| `/`             | Swagger UI                                        | Sign-in (see below)          |
| `/openapi.yaml` | The spec as YAML (`?download` saves it as a file) | Sign-in, or `SPEC_READ_TOKEN` |
| `/openapi.json` | The spec as JSON (`?download` saves it as a file) | Sign-in, or `SPEC_READ_TOKEN` |
| `/export/docs.html` | Single-file offline copy of the docs          | Sign-in                      |
| `/export/ts-stubs.zip` | Generated TypeScript + Express project     | Sign-in, or `SPEC_READ_TOKEN` |
| `/mcp`          | MCP endpoint so Claude can read and edit the spec | `MCP_TOKEN`                  |
| `/healthz`      | Health check                                      | Public (returns `{"ok":true}` only) |

"Sign-in" depends on `AUTH_MODE`:

- **`AUTH_MODE=none`**: this server asks no one to sign in. Put it behind **Pomerium** (or another
  authenticating proxy), which signs people in and decides who gets through. Anyone who reaches the
  server directly can read everything except `/mcp`, so only Pomerium may reach it.
- **`AUTH_MODE=oidc`** or **`nextcloud-oauth2`**: the server signs people in with Nextcloud itself.
  See [Nextcloud sign-in](#nextcloud-sign-in-instead-of-pomerium).

## Quick start (Pomerium)

```bash
cp .env.example .env      # AUTH_MODE=none; set MCP_TOKEN with: openssl rand -hex 32
docker compose up -d --build
docker compose logs -f    # check for configuration errors
```

On first start a starter spec is written to `./spec/openapi.yaml`. An existing spec there is never
overwritten. If the container can't write there on Linux, run `sudo chown 1000:1000 spec` (it runs
as uid 1000).

### Pomerium routes

Pomerium must protect the docs but let MCP clients through, because `/mcp` has its own token and
claude.ai connects from Anthropic's servers, which can't sign in to Pomerium. Put the `/mcp` route
**first**: Pomerium uses the first route that matches.

```yaml
routes:
  - from: https://docs.example.com
    prefix: /mcp
    to: http://swagger-docs:8080        # or http://127.0.0.1:8080 if Pomerium runs on the host
    allow_public_unauthenticated_access: true

  - from: https://docs.example.com
    to: http://swagger-docs:8080
    pass_identity_headers: true          # lets the docs page show "Signed in as ..."
    policy:
      - allow:
          or:
            - domain:
                is: example.com          # or groups / emails, as you like
```

- `swagger-docs:8080` works when Pomerium is on the same Docker network as this container (e.g. add
  it to this compose project, or attach both to a shared external network). If Pomerium runs on the
  host, use `http://127.0.0.1:8080`, which the compose file publishes on localhost only.
- Never publish port 8080 on a public interface: with `AUTH_MODE=none` the docs would be open.
- With `pass_identity_headers`, the top bar shows the Pomerium user and its **Sign out** link goes to
  Pomerium's `/.pomerium/sign_out`. The identity is only displayed; Pomerium alone decides access.
- For CI downloads behind Pomerium, either use a Pomerium service account, or add another
  public route with a narrow `prefix` and protect it yourself.

## Cloudflare Tunnel (optional)

The `cloudflared` service only starts when `TUNNEL_TOKEN` in `.env` is set. Leave it empty (for
example when Pomerium publishes the docs) and `docker compose up` starts the docs server alone;
emptying it later and running `docker compose up -d` removes a running tunnel container.

To use it:

1. In the Cloudflare dashboard, create a tunnel (Zero Trust → Networks → Tunnels → Create a
   tunnel → Cloudflared). Copy the token from the install command it shows (the long string after
   `--token`) into `TUNNEL_TOKEN` in `.env`.
2. Add a public hostname to the tunnel with service type `HTTP` and URL `swagger-docs:8080`
   (the docs container's name on the Docker network both containers share).
3. Set `PUBLIC_URL` in `.env` to that hostname and run `docker compose up -d`.

Notes:

- With `AUTH_MODE=none`, the tunnel publishes the docs **without sign-in** unless Cloudflare Access
  protects the hostname. The server logs a warning when both are set.
- Use `HTTP`, not `HTTPS`, as the service type: Cloudflare provides the HTTPS, and the hop between
  the two containers stays inside Docker.
- Every signed-in response is marked private, so Cloudflare never caches the docs and serves them
  to someone else. Don't add Cache Rules that override this for this hostname.
- If you put Cloudflare Access in front, add a bypass for `/mcp*`, or Claude won't be able to connect.

## Connecting Claude (MCP)

The MCP endpoint is never behind the docs sign-in; it uses `MCP_TOKEN`. Send
`Authorization: Bearer <MCP_TOKEN>`, or for clients that can't set headers, put the token in
the URL: `https://docs.example.com/mcp/<MCP_TOKEN>`.

Claude Code (on the same machine):

```bash
claude mcp add --transport http swagger-docs http://localhost:8080/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

A claude.ai custom connector connects from Anthropic's servers, so it needs the public HTTPS
address, e.g. `https://docs.example.com/mcp`. See https://support.claude.com for how to add a custom
connector and which authentication options it supports.

Tools: `get_spec`, `list_routes`, `get_route`, `upsert_route`, `delete_route`,
`list_schemas`, `get_schema`, `upsert_schema`, `delete_schema`, `update_info`,
`replace_spec`, `validate_spec`. Every change is validated against OpenAPI 3.0 before it is
saved; invalid edits are rejected and the file is left untouched.

The MCP server sends instructions to every Claude session that connects, explaining that the spec
is the source of truth, that the TypeScript + Express backend is generated from it (so operationIds
become handler method names and tags become interface names), and that breaking changes need the
user's confirmation. Edit `INSTRUCTIONS` in `src/mcp-tools.ts` to add your own conventions.

## Exporting

The bar at the top of the docs page has four downloads:

- **openapi.yaml** and **openapi.json**: the standard OpenAPI 3.0 spec, importable into
  Postman, Insomnia, Redoc, Stoplight, openapi-generator, or any other OpenAPI tool.
  Files are named from the spec's title and version, e.g. `my-api-0.1.0.yaml`.
- **TypeScript stubs (.zip)**: a ready-to-run Node.js + Express 5 + TypeScript project generated
  from the current spec:
  - `src/generated/`: types for every schema and operation (via
    [openapi-typescript](https://openapi-ts.dev)), one handler interface per tag (tag `Orders` →
    `OrdersApi`, one method per operationId), and the Express routes. Replace this folder whenever
    the spec changes.
  - `src/handlers/`: one class per tag implementing its interface; each method answers
    `501 Not Implemented` until filled in. Yours to keep.
  - `src/server.ts`: an Express app that validates every request (and, in development, every
    response) against `openapi.yaml` with `express-openapi-validator`, then calls the handlers.

  Handlers get typed path, query, header and body values, and TypeScript rejects any status code or
  body the spec doesn't list for that operation. The zip's README explains how to update it after a
  spec change and how to fetch it in CI.
- **Offline HTML**: one self-contained HTML file with Swagger UI and the spec built in. It opens
  from a file or email attachment with no server, internet connection or sign-in, so treat it as
  you would the spec itself before sharing it outside your team.

In CI, with the read token (not needed with `AUTH_MODE=none` if CI can reach the server):

```bash
curl -fsS -H "Authorization: Bearer $SPEC_READ_TOKEN" https://docs.example.com/export/ts-stubs.zip -o stubs.zip
```

## Nextcloud sign-in (instead of Pomerium)

Set `AUTH_MODE` to one of these and fill in the Nextcloud section of `.env`:

**`AUTH_MODE=oidc`.** Install the **OIDC Identity Provider** app from the Nextcloud app store, then
add a client in its admin settings with the redirect URI `https://docs.example.com/auth/callback`
(your `PUBLIC_URL` + `/auth/callback`). This gives signed identity tokens and can include group
membership.

**`AUTH_MODE=nextcloud-oauth2` (no app needed).** In Nextcloud go to *Administration settings →
Security → OAuth 2.0 clients* and add a client with the same redirect URI. Tokens from this built-in
provider grant broad access to the user's account; this server uses the token once to read the
user's identity and never stores it.

Copy the client ID and secret into `.env`, set `SESSION_SECRET`, and choose who may sign in with
`ALLOWED_GROUPS` and/or `ALLOWED_USERS` (Nextcloud group names / user IDs). If both are empty, every
account on your Nextcloud can read the docs, and the server logs a warning. If the logs say
*"Nextcloud sent no group information"*, enable groups in the OIDC app (add `groups` to
`OIDC_SCOPES` if your app version needs it) or list people in `ALLOWED_USERS` instead.

Sign-in sessions are stored in a signed cookie and can't be revoked one at a time. Removing someone
from the allowed groups takes effect at their next sign-in, so a session lasts up to
`SESSION_HOURS`. To cut everyone off immediately, change `SESSION_SECRET` and restart.

## Development

```bash
npm install
npm run dev         # runs src/server.ts with tsx, restarts on change
npm run typecheck
npm run build       # compiles to dist/; npm start runs it
```

Set at least `MCP_TOKEN` and `AUTH_MODE=none` in the environment, and `SPEC_PATH` to a writable file
(default `./data/openapi.yaml`).

## Upgrading from the Java/Spring stub version

Your spec in `./spec/openapi.yaml` is kept as is: the volume and file path haven't changed.

1. Move the token from `tunnel.env` into `TUNNEL_TOKEN` in `.env` (or leave it empty to stop using the
   tunnel), then delete `tunnel.env`.
2. Remove `STUBS_BASE_PACKAGE` from `.env`; it is no longer used.
3. For Pomerium, set `AUTH_MODE=none` and add the routes above.
4. `docker compose up -d --build`.

The Spring stub download (`/export/spring-stubs.zip`) is replaced by `/export/ts-stubs.zip`, and the
image no longer contains Java.

## Security notes

What the server enforces:

- With Nextcloud sign-in, every path except `/healthz` and the `/auth/*` sign-in pages returns the
  same `401` to anyone not signed in, so nothing can be read and nothing reveals which files exist.
  With `AUTH_MODE=none`, that job belongs to Pomerium.
- The spec may only contain internal references (`#/components/...`). External `$ref` values
  are rejected, so neither this server nor a build consuming the spec can be made to read local
  files or fetch arbitrary URLs.
- Strict security headers (Content-Security-Policy, no framing, no referrer, nosniff, and HSTS
  when `PUBLIC_URL` is HTTPS). Swagger UI's online validator badge is disabled, so viewers'
  browsers don't send your docs address to swagger.io.
- Only the two Swagger UI files the page needs are served. Errors never include details.

What you need to look after:

- Keep `.env` out of Git (it's in `.gitignore`), and generate every secret with
  `openssl rand -hex 32` rather than typing one. `.env` now also holds `TUNNEL_TOKEN`, which lets
  anyone run a connector for your hostname.
- With `AUTH_MODE=none`, make sure only Pomerium can reach port 8080.
- `MCP_TOKEN` can rewrite the spec; `SPEC_READ_TOKEN` can only read it. Prefer the
  `Authorization` header over the `/mcp/<token>` URL form, because URLs end up in reverse-proxy
  logs. Rotate a token by editing `.env` and running `docker compose up -d`.
- The **Offline HTML** export contains the whole spec and opens without sign-in. Anyone who can
  read the docs can download it.
- With Nextcloud sign-in, the container trusts `X-Forwarded-*` headers from private network
  addresses (needed behind cloudflared or a proxy). Keep the port bound to `127.0.0.1` as in
  `docker-compose.yml`.
