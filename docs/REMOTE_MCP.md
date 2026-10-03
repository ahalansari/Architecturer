# Remote MCP server

Run Architecturer on a home server (Unraid, a NAS, any Docker host) behind a Cloudflare Tunnel, and use it from any MCP client: Claude on the web, desktop and mobile, ChatGPT, LM Studio, Claude Code.

```
            Claude / ChatGPT (their cloud)         LM Studio, Claude Code (your machine)
                         │  OAuth                               │  OAuth or personal token
                         ▼                                      ▼
   https://arch.example.com ── Cloudflare (Access only on the human pages) ── tunnel
                         │
                  cloudflared container ──► architecturer container :5178
                                              ├─ /mcp, /mcp/core   MCP (Streamable HTTP, stateless)
                                              ├─ OAuth: /.well-known/*, /register, /authorize, /token, /revoke
                                              ├─ /view/<project>/  live 3D viewer (login)
                                              ├─ /admin            connected apps, tokens (login)
                                              └─ /files/...        signed download links
```

## What changes compared with the local server

- **Projects by name.** Tools take a project name (`house`, `clients/villa`) inside the project folder (`/data/plans` in Docker), not a file path. Use `list_projects` to see them. Nothing outside that folder can be read or written.
- **Links instead of paths.**
  - `export_model` and `cost_estimate` return download links that expire after 7 days.
  - Renders come back as an inline image plus a link that expires after 24 hours.
  - `create_project` and `list_projects` include a link to the live 3D viewer.
- **Background exports.** A big export can take minutes, longer than chat apps wait for a reply. `export_model` answers within about 25 s. If the export is still running by then, the reply says so, `export_status` reports progress, and the download link shows "still exporting" until the file is ready.
- **Two tool sets.** `/mcp` has every tool. `/mcp/core` has 10, for small local models that get confused by long tool lists.
- **Guarded network access.** Plans and product imports can't make the server fetch private network addresses (your router, the Unraid UI). Set `ARCHITECTURER_ALLOW_PRIVATE_FETCH=1` if you keep models on a LAN server.

## Quick start (Docker Compose)

```bash
cp .env.example .env    # fill it in (below)
docker compose up -d --build
```

`compose.yaml` runs two containers:
- `architecturer`, with no published port.
- `cloudflared`, which connects your tunnel.

Data lives in one folder, mounted at `/data`:

| Path | Contents |
|---|---|
| `/data/plans` | Your projects. Exports go to `/data/plans/exports`. |
| `/data/state` | OAuth clients, token hashes, the signing key, and renders kept for 24 hours. Back it up; keep it private. |
| `/data/cache` | Downloaded CC0 textures, models and vendor pages. |

### Unraid

**Option A: Unraid template (no Compose).** Use this if you already run `cloudflared` (as a container or plugin).

1. Copy [`unraid/architecturer.xml`](../unraid/architecturer.xml) to `/boot/config/plugins/dockerMan/templates-user/my-architecturer.xml` on the flash drive.
2. In the Docker tab, choose **Add Container** and select the **architecturer** template.
3. Fill in the public URL and the login settings.
4. Point the tunnel's public hostname to `http://<unraid-ip>:5178`.

The image is `aalansari/architecturer` (amd64 and arm64). The template's WebUI link opens `/admin` on the LAN, which works with the password login. Cloudflare Access login works only through the tunnel.

**Option B: Compose.** Install the **Compose Manager** plugin, create a stack, and paste in `compose.yaml` and your `.env`.

Notes for both:

- Set `ARCHITECTURER_DATA=/mnt/cache/appdata/architecturer`, or a `/mnt/diskN/...` path. Avoid `/mnt/user/...`: file-change events through Unraid's `shfs` layer are unreliable, so the viewer might not reload when a plan changes.
- The container runs as `99:100` (`nobody:users`), Unraid's appdata owner.
- **Memory.**
  - Measured on a large furnished plan (the showcase apartment: 14 IKEA models, 1024 px textures): an export peaked at about **3.5 GB** and a 3D render at about **1.8 GB**. Simple plans use far less.
  - Keep `ARCHITECTURER_WORKERS=1` with `ARCHITECTURER_MEMORY=4g`. For two exports at once, use 2 workers and about 8 GB.
- **CPU.** Each worker uses one core while busy and nothing when idle. There's no GPU use: renders are a software rasterizer, and the 3D viewer draws on the visitor's GPU.

## Cloudflare setup

1. **Tunnel.** Go to Zero Trust → Networks → Tunnels and create a tunnel (cloudflared). Copy its token into `CLOUDFLARE_TUNNEL_TOKEN`.
2. **Public hostname.** Point `arch.example.com` to service `http://architecturer:5178`. Set `ARCHITECTURER_PUBLIC_URL=https://arch.example.com`.
3. **Access application** (this is your login).
   - Go to Zero Trust → Access → Applications and add a **self-hosted** application.
   - Give it these paths on your hostname: `authorize`, `admin`, `view` and `login`.
   - Add a policy that allows your email.
   - From the application's overview, copy its **Application Audience (AUD) tag** into `CF_ACCESS_AUD`. Put your team domain (`<team>.cloudflareaccess.com`) into `CF_ACCESS_TEAM_DOMAIN`.
   - Put your email in `ARCHITECTURER_ALLOWED_EMAILS`.
4. **Leave every other path open:** `/mcp`, `/.well-known/`, `/register`, `/token`, `/revoke`, `/files`, `/healthz`.
   - Claude and ChatGPT call these from their own servers, so they can't get past a login page or a browser challenge.
   - The server checks its own tokens on `/mcp`, and `/files` links are signed.
   - If Bot Fight Mode, Browser Integrity Check or "I'm Under Attack" are enabled for the zone, turn them off for this hostname, using a configuration rule where your plan allows it. Otherwise these requests can get challenged and the connector fails to connect.

Without Cloudflare Access, set `ARCHITECTURER_ADMIN_PASSWORD` to a long random password, and the pages show a login form instead. You can set both.

## Connecting clients

The server URL is `https://arch.example.com/mcp`.

| Client | How |
|---|---|
| Claude (claude.ai, desktop, mobile) | Settings → Connectors → add a custom connector with the URL. Claude registers itself, opens the consent page (log in through Access), and you click **Allow**. A connector you add on the web is also available in the desktop and mobile apps. |
| ChatGPT | In developer mode, create a connector with the URL and OAuth authentication. ChatGPT registers itself through dynamic client registration. |
| LM Studio | `mcp.json`: `{"mcpServers": {"architecturer": {"url": "https://arch.example.com/mcp/core"}}}` lets LM Studio 0.4.10+ use OAuth. Or add `"headers": {"Authorization": "Bearer <token>"}` with a personal token. Use `/mcp/core` for small models. |
| Claude Code | `claude mcp add --transport http architecturer https://arch.example.com/mcp`, then `/mcp` to log in. Or add `--header "Authorization: Bearer <token>"`. |

**Personal tokens** are for clients you configure with a header. Two ways to create one:
- On `/admin` (**New personal token**).
- From the CLI: `docker compose exec architecturer node bin/arch.js token create --name lmstudio`.

The token is shown once. `arch token list` and `arch token revoke --id <id>` manage tokens and connected OAuth apps; `/admin` has the same controls.

## Settings

| Variable | Default | |
|---|---|---|
| `ARCHITECTURER_PUBLIC_URL` | `http://localhost:<port>` | Public origin (`https://...`; plain http only for localhost). The OAuth issuer and every link use it. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | (none) | Log in with Cloudflare Access (set both). |
| `ARCHITECTURER_ALLOWED_EMAILS` | (none) | Comma-separated emails that may log in through Access. If empty, anyone the Access policy admits can log in. |
| `ARCHITECTURER_ADMIN_PASSWORD` | (none) | Log in with a password. |
| `ARCHITECTURER_WORKDIR` | `/data/plans` | Project folder. |
| `ARCHITECTURER_STATE` | `/data/state` | Auth state and renders. |
| `ARCHITECTURER_CACHE` | `/data/cache` | Asset download cache. |
| `ARCHITECTURER_WORKERS` | `1` (image) | Render/export worker threads. |
| `ARCHITECTURER_ALLOWED_HOSTS` | (none) | Extra accepted `Host` names (e.g. `tower.local`). The public host, localhost and IP addresses are always accepted. |
| `ARCHITECTURER_ALLOW_PRIVATE_FETCH` | off | Allow fetching from private network addresses. |
| `ARCHITECTURER_VIEWER_TEXTURE_SIZE` | `512` | Texture size of the model the viewer loads. |
| `PORT`, `HOST` | `5178`, `0.0.0.0` | Listen address. |

If no login is configured, OAuth is turned off and only personal tokens work.

Without Docker:

```bash
npm install
ARCHITECTURER_PUBLIC_URL=https://arch.example.com ARCHITECTURER_ADMIN_PASSWORD=... npx tsx src/cli/main.ts mcp --http --workdir ~/plans
```

After a build, run `node bin/arch.js mcp --http ...` or `node dist/mcp/http.js`.

## Security model

- **Login.**
  - `/mcp` accepts only tokens the server issued: OAuth access tokens (1 hour, with 30-day refresh tokens that rotate on every use) or personal tokens.
  - Tokens are stored as SHA-256 hashes.
  - A client gets tokens only after someone logs in and clicks **Allow** on the consent page. Anyone can register a client, but registration alone grants nothing.
- **Cloudflare Access.** The server verifies the JWT that Access adds against your team's signing keys, so a request that bypasses Access (from the LAN, say) can't impersonate you.
- **Forms.** Consent and admin forms carry CSRF tokens. Redirect URIs must be https, loopback http (local apps), or an app scheme.
- **Files.** Tools can't read or write outside the project folder; symlinks are resolved first. Downloads are signed, expiring links. Generated HTML (the cost estimate) is served as a download, never rendered on the server's origin.
- **Network.** The server doesn't fetch private, loopback or link-local addresses, including after redirects.
- **Abuse limits.** OAuth endpoints and the login form are rate-limited, and unknown `Host` headers are refused (DNS rebinding).

## Troubleshooting

| Symptom | Fix |
|---|---|
| The connector says it can't connect or authenticate | Open `https://arch.example.com/.well-known/oauth-authorization-server` in a private window. It must return JSON, not an Access login page or a challenge. If you get a challenge, check step 4 of the Cloudflare setup. |
| The consent page says "must be reached through Cloudflare Access" | Your Access application doesn't cover `/authorize`, or `CF_ACCESS_AUD` doesn't match the application's AUD tag. |
| An export reply says "still running" | Ask for `export_status`, or open the link; it turns into the download when the file is ready. KTX2 textures take several times longer than JPEG. |
| The container restarts during exports | The memory limit was hit. Raise `ARCHITECTURER_MEMORY`, or lower `textureSize` in the export. |
