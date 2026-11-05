# Remote MCP server

Run Architecturer on a home server (Unraid, a NAS, any Docker host) behind a Cloudflare Tunnel, and use it from any MCP client: Claude on the web, desktop and mobile, ChatGPT, LM Studio, Claude Code.

```
            Claude / ChatGPT (their cloud)         LM Studio, Claude Code (your machine)
                         │  OAuth                               │  OAuth or personal token
                         ▼                                      ▼
   https://arch.example.com ── Cloudflare Tunnel (or any HTTPS reverse proxy)
                         │
                  cloudflared container ──► architecturer container :5178
                                              ├─ /mcp, /mcp/core   MCP (Streamable HTTP, stateless)
                                              ├─ OAuth: /.well-known/*, /register, /authorize, /token, /revoke
                                              ├─ /setup, /login    built-in accounts (two-factor optional)
                                              ├─ /view/<project>/  live 3D viewer (login)
                                              ├─ /admin            apps, tokens, password, 2FA, sessions (login)
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
docker compose up -d
docker compose logs architecturer   # shows the setup code
```

Then open `https://arch.example.com/setup` and enter the setup code to create your account. That gives you the [login](#your-account).

`compose.yaml` runs two containers:
- `architecturer`, with no published port.
- `cloudflared`, which connects your tunnel.

Data lives in one folder, mounted at `/data`:

| Path | Contents |
|---|---|
| `/data/plans` | Your projects. Exports go to `/data/plans/exports`. |
| `/data/state` | Accounts (password hashes), sessions, OAuth clients, token hashes, the signing key, and renders kept for 24 hours. Back it up; keep it private. |
| `/data/cache` | Downloaded CC0 textures, models and vendor pages, and encoded textures from earlier exports. |

### Unraid

**Option A: Unraid template (no Compose).** Use this if you already run `cloudflared` (as a container or plugin).

1. Copy [`unraid/architecturer.xml`](../unraid/architecturer.xml) to `/boot/config/plugins/dockerMan/templates-user/my-architecturer.xml` on the flash drive.
2. In the Docker tab, choose **Add Container** and select the **architecturer** template.
3. Fill in the public URL.
4. Point the tunnel's public hostname to `http://<unraid-ip>:5178`.
5. Open the WebUI. It sends you to `/setup`; the setup code is in the container's log (Docker tab → the container's icon → **Logs**).

The image is `aalansari/architecturer` (amd64 and arm64).

**Option B: Compose.** Install the **Compose Manager** plugin, create a stack, and paste in `compose.yaml` and your `.env`.

Notes for both:

- If `appdata` is an exclusive (pool-only) share, the default `/mnt/user/appdata/architecturer` is fine. Otherwise, use a pool path such as `/mnt/cache/appdata/architecturer`: file-change events through Unraid's `shfs` layer are unreliable, so the viewer might not reload when a plan changes.
- The container runs as `99:100` (`nobody:users`), Unraid's appdata owner.
- **Memory.**
  - Measured on a large furnished plan (the showcase apartment: 14 IKEA models, 1024 px textures): an export peaked at about **3.5 GB** and a 3D render at about **1.8 GB**. Simple plans use far less.
  - Keep `ARCHITECTURER_WORKERS=1` with `ARCHITECTURER_MEMORY=4g`. For two exports at once, use 2 workers and about 8 GB.
- **CPU.** Each worker uses one core while busy and nothing when idle. The 3D viewer draws on the visitor's GPU.
- **GPU (optional, recommended).** `render_view` path-traces on the server's GPU through WebGPU (Dawn on Vulkan): real sun and sky for Kuwait at any date and time, daylight through windows, light bouncing between surfaces, the lighting design's lamps in candela, denoised. On Unraid with an NVIDIA card: install the **Nvidia Driver** plugin, keep `--runtime=nvidia` in Extra Parameters and `NVIDIA_VISIBLE_DEVICES` = `all` (or the card's UUID), and `NVIDIA_DRIVER_CAPABILITIES` must include `graphics` (it mounts the Vulkan driver). With compose, the `deploy.resources.reservations.devices` block does the same. A 1024×700 view at 128 samples takes about a second on a mid-range card; the render reply says which renderer drew it. The x86-64 image also carries Intel Open Image Denoise (the AI denoiser production renderers use; it runs on CUDA with the NVIDIA runtime), so 64–128 samples come out clean. Without a GPU (or `ARCHITECTURER_RENDERER=cpu`) renders use the software rasteriser. The same GPU runs `airflow_study` (a 3D airflow simulation of a floor, about a second per floor) and the viewer's 🌬 Airflow; those need a GPU.

## Your account

The server has its own login. You don't need Cloudflare Access or any other identity provider.

- **First start.** While no account exists, the server prints a one-time **setup code** in its log. Open `/setup` (any page sends you there), enter the code, and choose a username and password (12+ characters). After that, `/setup` is closed. The code keeps a stranger who finds the server first from claiming it.
- **Logging in.** The consent page that AI apps send you to, `/admin` and the viewer all ask you to log in. A session lasts 14 days; you can see and end your sessions on `/admin`.
- **Two-factor login** (recommended, since the server is on the internet). On `/admin`, choose **Two-factor login → Set up**, scan the QR code with an authenticator app, and enter the code it shows. From then on, a login asks for a 6-digit code after the password.
- **Password change** on `/admin`. It logs out every browser session. Apps you connected keep working; revoke those separately.
- **Locked out?** After 5 wrong passwords or codes, that account is locked for 15 minutes. If you forgot the password or lost the authenticator, use the container's console:

```bash
docker compose exec -it architecturer node bin/arch.js user passwd --name <you>
```

`user reset-2fa --name <you>` turns two-factor login off, `user add` creates another account, and `user list` / `user delete` manage accounts. In Unraid, use the container's **Console**: `node bin/arch.js user passwd --name <you>`.

## Cloudflare Tunnel

The tunnel only carries HTTPS to the container. Any other HTTPS reverse proxy (Caddy, Nginx Proxy Manager, Traefik) works the same way.

1. **Tunnel.** Go to Zero Trust → Networks → Tunnels and create a tunnel (cloudflared). Copy its token into `CLOUDFLARE_TUNNEL_TOKEN`.
2. **Public hostname.** Point `arch.example.com` to service `http://architecturer:5178` (with the template: `http://<unraid-ip>:5178`). Set `ARCHITECTURER_PUBLIC_URL=https://arch.example.com`.
3. **No challenges.** Claude and ChatGPT call `/mcp` and the OAuth endpoints from their own servers, so they can't solve a browser challenge. If Bot Fight Mode, Browser Integrity Check or "I'm Under Attack" are on for the zone, turn them off for this hostname, using a configuration rule where your plan allows it.

## Connecting clients

The server URL is `https://arch.example.com/mcp`.

| Client | How |
|---|---|
| Claude (claude.ai, desktop, mobile) | Settings → Connectors → add a custom connector with the URL. Claude registers itself and opens the consent page; you log in and click **Allow**. A connector you add on the web is also available in the desktop and mobile apps. |
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
| `ARCHITECTURER_WORKDIR` | `/data/plans` | Project folder. |
| `ARCHITECTURER_STATE` | `/data/state` | Auth state and renders. |
| `ARCHITECTURER_CACHE` | `/data/cache` | Asset download cache. |
| `ARCHITECTURER_WORKERS` | `1` (image) | Render/export worker threads. |
| `ARCHITECTURER_ALLOWED_HOSTS` | (none) | Extra accepted `Host` names (e.g. `tower.local`). The public host, localhost and IP addresses are always accepted. |
| `ARCHITECTURER_ALLOW_PRIVATE_FETCH` | off | Allow fetching from private network addresses. |
| `ARCHITECTURER_VIEWER_TEXTURE_SIZE` | `512` | Texture size of the model the viewer loads. |
| `PORT`, `HOST` | `5178`, `0.0.0.0` | Listen address. |

Without Docker:

```bash
npm install
ARCHITECTURER_PUBLIC_URL=https://arch.example.com npx tsx src/cli/main.ts mcp --http --workdir ~/plans
```

After a build, run `node bin/arch.js mcp --http ...` or `node dist/mcp/http.js`.

## Security model

- **Accounts.**
  - Passwords are stored as scrypt hashes (64 MB of memory per guess).
  - Sessions are random ids in an HttpOnly, SameSite cookie (Secure over https). The server stores only their hashes, so sessions can be listed and revoked.
  - A password change ends all of the account's sessions.
  - Two-factor codes are TOTP (RFC 6238) and can't be reused.
  - After 5 failures an account locks for 15 minutes, and the login forms are rate-limited per IP address.
  - A wrong username takes as long to reject as a wrong password, so attempts don't reveal which usernames exist.
  - The first account needs the setup code from the log.
- **Apps and tokens.**
  - `/mcp` accepts only tokens the server issued: OAuth access tokens (1 hour, with 30-day refresh tokens that rotate on every use) or personal tokens.
  - Tokens are stored as SHA-256 hashes.
  - A client gets tokens only after you log in and click **Allow** on the consent page. Anyone can register a client, but registration alone grants nothing.
- **Forms.** Consent and admin forms carry CSRF tokens. Redirect URIs must be https, loopback http (local apps), or an app scheme.
- **Files.** Tools can't read or write outside the project folder; symlinks are resolved first. Downloads are signed, expiring links. Generated HTML (the cost estimate) is served as a download, never rendered on the server's origin.
- **Network.** The server doesn't fetch private, loopback or link-local addresses, including after redirects.
- **Abuse limits.** OAuth endpoints and the login form are rate-limited, and unknown `Host` headers are refused (DNS rebinding).

## Troubleshooting

| Symptom | Fix |
|---|---|
| The connector says it can't connect or authenticate | Open `https://arch.example.com/.well-known/oauth-authorization-server` in a private window. It must return JSON, not a challenge page; if you get a challenge, see step 3 of [Cloudflare Tunnel](#cloudflare-tunnel). Also check that `ARCHITECTURER_PUBLIC_URL` is exactly the address clients use. |
| Lost the setup code | It's printed at every start while no account exists: restart the container and read the log again. |
| Forgot the password / lost the authenticator | `node bin/arch.js user passwd --name <you>` or `user reset-2fa` in the container's console (see [Your account](#your-account)). |
| An export reply says "still running" | Ask for `export_status`, or open the link; it turns into the download when the file is ready. KTX2 textures take several times longer than JPEG. |
| The container restarts during exports | The memory limit was hit. Raise `ARCHITECTURER_MEMORY`, or lower `textureSize` in the export. |
