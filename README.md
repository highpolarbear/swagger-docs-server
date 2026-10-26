# Swagger docs server with Nextcloud sign-in and MCP

A standalone, design-first API docs server. One container serves:

| URL             | What                                              | Access                       |
|-----------------|---------------------------------------------------|------------------------------|
| `/`             | Swagger UI                                        | Nextcloud sign-in            |
| `/openapi.yaml` | The spec as YAML (`?download` saves it as a file) | Nextcloud sign-in, or `SPEC_READ_TOKEN` |
| `/openapi.json` | The spec as JSON (`?download` saves it as a file) | Nextcloud sign-in, or `SPEC_READ_TOKEN` |
| `/export/docs.html` | Single-file offline copy of the docs          | Nextcloud sign-in            |
| `/mcp`          | MCP endpoint so Claude can read and edit the spec | `MCP_TOKEN`                  |
| `/auth/logout`  | Sign out                                          |                              |
| `/healthz`      | Health check                                      | Public (returns `{"ok":true}` only) |

## 1. Create a client in Nextcloud

Pick one, and set `AUTH_MODE` to match.

**`AUTH_MODE=oidc` (recommended).** Install the **OIDC Identity Provider** app from the
Nextcloud app store, then add a client in its admin settings with the redirect URI
`https://docs.example.com/auth/callback` (your `PUBLIC_URL` + `/auth/callback`).
This gives signed identity tokens and can include group membership.

**`AUTH_MODE=nextcloud-oauth2` (no app needed).** In Nextcloud go to
*Administration settings → Security → OAuth 2.0 clients* and add a client with the
same redirect URI. Note that tokens from this built-in provider grant broad access to the
user's account; this server uses the token once to read the user's identity and never stores it.

Copy the client ID and secret into `.env`.

## 2. Choose who may sign in

Set `ALLOWED_GROUPS` and/or `ALLOWED_USERS` (Nextcloud group names / user IDs). If both are
empty, every account on your Nextcloud can read the docs, and the server logs a warning.

Group checks need Nextcloud to send group membership. If the logs say *"Nextcloud sent no group
information"*, either enable groups in the OIDC app (add `groups` to `OIDC_SCOPES` if your app
version needs it) or list people in `ALLOWED_USERS` instead.

## 3. Create a Cloudflare Tunnel

The included `cloudflared` container publishes the docs on your domain over HTTPS, with no open
ports on your machine.

1. In the Cloudflare dashboard, create a tunnel (Zero Trust → Networks → Tunnels → Create a
   tunnel → Cloudflared). Copy the token from the install command it shows (the long string
   after `--token`) into `tunnel.env`:
   ```bash
   cp tunnel.env.example tunnel.env   # then paste the token
   ```
2. Add a public hostname to the tunnel:

   | Field     | Value                       |
   |-----------|-----------------------------|
   | Subdomain / domain | e.g. `docs` . `example.com` |
   | Service type | `HTTP`                   |
   | URL       | `swagger-docs:8080`         |

   `swagger-docs` is the docs container's name on the Docker network that both containers share,
   so cloudflared reaches it directly.
3. Set `PUBLIC_URL=https://docs.example.com` in `.env`, and use
   `https://docs.example.com/auth/callback` as the redirect URI in Nextcloud.

Notes:

- Use `HTTP`, not `HTTPS`, as the service type: Cloudflare provides the HTTPS, and the hop
  between the two containers stays inside Docker.
- Every signed-in response is marked private, so Cloudflare never caches the docs and serves them
  to someone else. Don't add Cache Rules that override this for this hostname.
- If you also put Cloudflare Access in front, add a bypass for `/mcp*`, or Claude won't be able
  to connect. The docs are already protected by the Nextcloud sign-in.

## 4. Run

```bash
cp .env.example .env      # fill it in; generate secrets with: openssl rand -hex 32
docker compose up -d --build
docker compose logs -f    # check for configuration errors
```

The docs server starts only if its configuration is complete, and checks it can reach Nextcloud
(in OIDC mode). The tunnel starts once the docs server reports healthy. Then open
`https://docs.example.com`.

On first start a starter spec is written to `./spec/openapi.yaml`. If the container can't
write there on Linux, run `sudo chown 1000:1000 spec` (it runs as uid 1000).

The compose file also maps the server to `http://localhost:8080` on this machine only, for local
tools such as Claude Code. Remove the `ports:` lines if you don't need that.

### Without Cloudflare

Remove the `cloudflared` service and put any HTTPS reverse proxy in front of
`127.0.0.1:8080` instead, e.g. with Caddy:

```
docs.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Connecting Claude (MCP)

The MCP endpoint is not behind the Nextcloud login; it uses `MCP_TOKEN`. Send
`Authorization: Bearer <MCP_TOKEN>`, or for clients that can't set headers, put the token in
the URL: `https://docs.example.com/mcp/<MCP_TOKEN>`.

Claude Code (on the same machine):

```bash
claude mcp add --transport http swagger-docs http://localhost:8080/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

A claude.ai custom connector connects from Anthropic's servers, so it needs the public HTTPS
address, e.g. `https://docs.example.com/mcp`. See https://support.claude.com for how to add a custom connector and which
authentication options it supports.

Tools: `get_spec`, `list_routes`, `get_route`, `upsert_route`, `delete_route`,
`list_schemas`, `get_schema`, `upsert_schema`, `delete_schema`, `update_info`,
`replace_spec`, `validate_spec`. Every change is validated against OpenAPI 3.0 before it is
saved; invalid edits are rejected and the file is left untouched.

## Exporting

The bar at the top of the docs page has three downloads:

- **openapi.yaml** and **openapi.json**: the standard OpenAPI 3.0 spec, importable into
  Postman, Insomnia, Redoc, Stoplight, openapi-generator, or any other OpenAPI tool.
  Files are named from the spec's title and version, e.g. `my-api-0.1.0.yaml`.
- **Offline HTML**: one self-contained HTML file with Swagger UI and the spec built in. It opens
  from a file or email attachment with no server, internet connection or sign-in, so treat it as
  you would the spec itself before sharing it outside your team.

## Design-first instructions for Claude

The MCP server sends instructions to every Claude session that connects, explaining that the
spec is the source of truth, that Spring code is generated from it (so operationIds become Java
method names and tags become interface names), and that breaking changes need the user's
confirmation. Edit `INSTRUCTIONS` in `src/mcp-tools.js` to add your own conventions.

## Using the spec from a Spring build

Either commit `spec/openapi.yaml` to Git and point `openapi-generator-maven-plugin`'s
`<inputSpec>` at a tagged copy (most reproducible), or download it in CI with the read token:

```bash
curl -fsS -H "Authorization: Bearer $SPEC_READ_TOKEN" \
  https://docs.example.com/openapi.yaml -o openapi.yaml   # or /openapi.json
```

## Security notes

What the server enforces:

- Without signing in, every path except `/healthz` and the `/auth/*` sign-in pages returns the
  same `401`, so nothing can be read and nothing reveals which files exist.
- The spec may only contain internal references (`#/components/...`). External `$ref` values
  are rejected, so neither this server nor a build consuming the spec can be made to read local
  files or fetch arbitrary URLs.
- Strict security headers (Content-Security-Policy, no framing, no referrer, nosniff, and HSTS
  when `PUBLIC_URL` is HTTPS). Swagger UI's online validator badge is disabled, so viewers'
  browsers don't send your docs address to swagger.io.
- Only the two Swagger UI files the page needs are served. Errors never include details.

What you need to look after:

- Keep `.env` out of Git (it's in `.gitignore`), and generate every secret with
  `openssl rand -hex 32` rather than typing one.
- `MCP_TOKEN` can rewrite the spec; `SPEC_READ_TOKEN` can only read it. Prefer the
  `Authorization` header over the `/mcp/<token>` URL form, because URLs end up in reverse-proxy
  logs. Rotate a token by editing `.env` and running `docker compose up -d`.
- Sign-in sessions are stored in a signed cookie and can't be revoked one at a time. Removing
  someone from the allowed groups takes effect at their next sign-in, so a session lasts up to
  `SESSION_HOURS`. To cut everyone off immediately, change `SESSION_SECRET` and restart.
- The **Offline HTML** export contains the whole spec and opens without sign-in. Anyone who can
  read the docs can download it.
- The container trusts `X-Forwarded-*` headers from private network addresses (needed behind
  cloudflared or a proxy). Keep the port bound to `127.0.0.1` as in `docker-compose.yml`.
- Keep `tunnel.env` secret: the tunnel token lets anyone run a connector for your hostname.
