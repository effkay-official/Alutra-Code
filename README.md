# Alutra Code

Alutra Code is a local, multi-provider AI workspace for everyday coding questions and guarded software-building tasks. It has a React/Vite interface and an Express API, with adapters for OpenAI, OpenRouter, OpenCode Zen, Anthropic, Google Gemini, DeepSeek, Perplexity, and GitHub Copilot.

## Features

- **Daily Questions** keeps a persisted conversation thread for focused debugging, explanations, and snippets.
- **Agent Mode** plans the task, then runs a guarded tool loop (write/edit/read/ls/glob/grep/bash/fetch/sub-agent) inside a new local workspace with per-tool approval.
- **Eight provider adapters** share one chat interface. Select a provider explicitly or choose **Auto** to try configured providers in order.
- **Streaming responses** over SSE and CRUD sessions with an LLM-based compact summarizer.
- **Rate-limit fallback** puts providers returning HTTP 429 or 5xx into a 60-second cooldown. Auto mode then tries another configured provider.
- **No hosted key store**. Server keys live in `server/.env`; the UI key vault is an optional local-browser convenience and its values are only posted to your own local API for a request.
- Conversation records are JSON files in `server/data/` and agent output is written under `server/agent-workspaces/` by default. Both are gitignored.

## Requirements

- Node.js 20 or newer (Node 18+ supports `fetch`, but Node 20 is recommended)
- API key from at least one supported provider

## Quick Start

1. Copy `.env.example` to `server/.env`.
2. Add one or more provider keys to `server/.env`.
3. Launch with `start.bat` on Windows or `./start.sh` on macOS/Linux.
4. Open `http://localhost:5173`.

Equivalent manual commands:

```sh
npm run install:all
npm run dev
```

The API listens on `http://localhost:8787`. The Vite client listens on `http://localhost:5173`.

## Desktop App (.exe)

Alutra Code ships as a native desktop app via Electron. The Express backend runs in the
background inside the app, so you get a standalone window with no browser tab. The
packaged app:

- **Runs on any Windows laptop with nothing else installed** — Electron bundles its own
  Node runtime, the API server, and the built UI in a single package (installer + a
  portable `-portable.exe`).
- Picks a **free local port** automatically (default 8787; if it's taken, the next free
  one is used), so it never fails just because another app owns the default port.
- Writes conversation data and agent workspaces under the OS **user-data directory**, so
  state persists per-user and the app is fully self-contained.

```sh
# Quick dev run: builds the client, opens the Electron window
npm run electron

# Build installers/portable exe into release/
npm run dist            # current OS
npm run dist:win        # Windows (NSIS installer + portable .exe)
npm run dist:mac        # macOS (DMG)
npm run dist:linux      # Linux (AppImage)
```

- **Windows outputs**:
  - `release/Alutra-Code-<version>-x64.exe` — NSIS installer (desktop/start-menu shortcuts).
  - `release/Alutra-Code-<version>-portable.exe` — single file; copy it to any PC and
    double-click. It uses the bundled icon and works without installing.
- **Provider keys**: the packaged app reads `server/.env` at build time, so a local build
  **carries your configured keys** (OpenRouter, OpenCode Zen, GitHub OAuth) with it. That
  makes a laptop copy work out of the box, but anyone who extracts the app can read those
  keys. For builds you distribute publicly (e.g. the GitHub Actions release), `server/.env`
  is gitignored so CI builds ship **without** keys and users add their own.
- Data and agent workspaces are written under the OS user-data directory
  (e.g. `%APPDATA%/<app>/data`) so nothing is lost between launches.
- The installer is unsigned, so Windows SmartScreen may warn you — choose
  "More info" → "Run anyway" for your own build.

## Custom Icon & Code Signing

Icons are generated programmatically (no design tool or dependency needed) and written to
`build/`:

```sh
npm run icons   # writes build/icon.ico, build/icon.icns, build/icon.png
```

To distribute without SmartScreen/notarization warnings, sign the build with your own
certificates:

- **Windows**: drop a code-signing PFX (or use an Azure Trusted Signing cert) and set the
  two environment variables electron-builder looks for, then `npm run dist:win`:

  ```sh
  set CSC_LINK=path\to\certificate.pfx
  set CSC_KEY_PASSWORD=yourcertpassword
  npm run dist:win
  ```

- **macOS**: use `CSC_LINK`/`CSC_KEY_PASSWORD` for the Developer ID Application cert and
  set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` to enable notarization:
  remove `"notarize": false` from `package.json` under `build.mac`, then `npm run dist:mac`.

Signed builds keep the same generated icon; nothing else changes.

## Publishing a Release (.exe download)

The repo includes a GitHub Actions workflow (`.github/workflows/release.yml`) that builds
the Windows installer and attaches it to a GitHub Release. To publish a downloadable
installer from the repo page:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The workflow runs on GitHub's hosted Windows runner, uploads `Alutra-Code-*.exe`
(installer + portable), and creates a Release with download links under **Releases** →
**Latest**. CI builds do **not** include `server/.env` keys (the file is gitignored), so a
public release asks users to add their own provider keys.

## GitHub Integration

Alutra Code can link to GitHub as a third-party app so repositories can be connected to
agent tasks. This uses the standard **OAuth App** flow:

1. Create an OAuth App at https://github.com/settings/developers/apps with:
   - **Homepage URL**: `http://localhost:8787`
   - **Authorization callback URL**: `http://localhost:8787/api/github/callback`
   - Scopes granted automatically: `repo`, `workflow`, `read:user`
2. Put the client ID and secret in `server/.env`:

   ```sh
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

3. In the app, open **Linked with GitHub** → **Sign in with GitHub**. The token is stored
   locally under `server/data/github.json` and is used to list your repositories (`List them
   via the API from the client`) and is offered to agent sessions for repo publishing.

> Note: There is no "link to ChatGPT" OAuth for desktop apps. OpenAI does not expose an
> OAuth sign-in for consumer ChatGPT accounts to third parties — the supported third-party
> integration is an **API key**, which Alutra already uses. If you need ChatGPT model
> access, add an API key in the key vault or `server/.env` and choose `ChatGPT` / Auto.

## Streaming & Live Responses

Chat and agent mode stream their output over Server-Sent Events (`/api/chat/stream` and
`/api/agent/stream`), so text appears live instead of after completion. If a provider key
is missing or a rate limit hits mid-stream, the client shows the error inline.

## Agent Tool Loop

Agent mode now uses an opencode-style tool loop instead of only `write` + `command`:

- Tools: `write`, `edit`, `read`, `ls`, `glob`, `grep`, `bash`, `fetch`, and sub-agent.
- The agent plans first, then iterates: choose tools → run them → summarize → continue until `done`.
- **Permissions**: read-only tools run freely. `write`, `edit`, `fetch`, sub-agents, and
  network/executable `bash` commands pause and ask for your approval — **Allow once**,
  **Always allow**, or **Deny** (matching opencode's grant/deny model).
- Safety: bash blocks operator-heavy commands, harmful executables, and anything outside
  the task workspace; commands time out after 60s by default (max 600s).

## GitHub Copilot

Copilot is available as a provider (`gpt-4o` by default, override with `COPILOT_MODEL`).
It reuses your **connected GitHub OAuth token** OR `GITHUB_TOKEN` in `server/.env`. Note:
GitHub only grants Copilot API access to tokens carrying the `copilot` scope. If your
connected token lacks it, run `gh auth login --scopes copilot` on the server machine and
set `GITHUB_TOKEN` in `server/.env`. Alutra will report `configured: false` until the
token exchange actually succeeds.

## Sessions & Auto-Compact

- The sidebar lists your saved conversations (titles auto-derived from the first message).
- **Summarize & compact** replaces the current thread with an LLM-condensed summary so you
  can keep going without losing context (opencode's compact behavior).

## Environment Variables

Place these in `server/.env`; do not commit the file.

| Variable | Purpose | Default model |
| --- | --- | --- |
| `OPENAI_API_KEY` | OpenAI / ChatGPT API key | `gpt-4o-mini` |
| `OPENROUTER_API_KEY` | OpenRouter (free tiers available) | `openai/gpt-4o-mini` |
| `OPENCODE_API_KEY` | OpenCode Zen (opencode.ai/auth), incl. free models | `deepseek-v4-flash-free` |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | `claude-3-5-haiku-latest` |
| `GEMINI_API_KEY` | Google AI Studio key | `gemini-1.5-flash` |
| `DEEPSEEK_API_KEY` | DeepSeek API key | `deepseek-chat` |
| `PERPLEXITY_API_KEY` | Perplexity API key | `llama-3.1-sonar-small-128k-online` |
| `PORT` | Local API port | `8787` |
| `ALLOWED_ORIGIN` | Browser origin permitted by CORS | `http://localhost:5173` |
| `DATA_DIR` | Conversation data directory | `./data` |
| `WORKSPACE_ROOT` | Agent output directory | `./agent-workspaces` |

Set `OPENAI_MODEL`, `OPENROUTER_MODEL`, `OPENCODE_MODEL`, `ANTHROPIC_MODEL`,
`GEMINI_MODEL`, `DEEPSEEK_MODEL`, or `PERPLEXITY_MODEL` to override a model.

## Free Tier Notes

Provider pricing, trial credits, and model availability change frequently. This app does not claim that a specific commercial API is permanently free. Use models and accounts that your provider currently offers within your budget. Gemini's AI Studio quota is often a useful free starting point; DeepSeek may also be low cost. Confirm current quotas directly with each provider.

`Auto (best available)` does not bypass provider quotas. It only attempts another configured provider after a retryable provider error. Use explicit selection when model behavior matters.

## Agent Safety Model

Agent Mode is intentionally constrained, not a general shell. Each task receives a new
workspace; paths that escape it are rejected. Bash tools block shell operators and harmful
executables, require approval for network/executable commands, and time out (60s default).
Read-only tools run freely. Review generated code before using it in a production system.

The agent endpoint streams each phase (plan, workspace, permission request, tool events,
completion) over SSE, and the client shows approval banners for mutating actions.

## Project Layout

```text
alutra-code/
  client/              React + Vite dark interface
  server/              Express API, LLM adapters, store, agent runner
  shared/              Provider definitions shared by client/server
  electron/            Desktop shell (main process, spawns the server)
  .env.example         Environment configuration template
  start.sh / start.bat Local launchers
```

## Production (Internet) Deployment

Alutra Code can run as a normal public web app — the same Express server serves both the
built UI and the API, so no separate static host is required. The client uses relative
`/api` paths, so it works from any domain.

### Option A — Docker (recommended)

A `Dockerfile` is included. It installs all dependencies, builds the client, and runs the
server in a containerized production image:

```sh
# from the repo root
docker build -t alutra-code .
docker run -d --name alutra-code -p 8787:8787 \
  -v your_data_dir:/app/server/data \
  -v your_workspaces:/app/server/agent-workspaces \
  --env-file server/.env \
  alutra-code
```

Mount volumes for `server/data` and `server/agent-workspaces` so conversations and agent
output survive container rebuilds, and keep `server/.env` out of the image.

### Option B — Direct Node

```bash
npm run build --prefix client
npm run serve        # node server/src/index.js, serves client/dist + API on PORT
```

### Configuring the public OAuth callback

1. In `server/.env` on the deployed machine set:
   ```sh
   PORT=8787                        # or 80/443 behind a reverse proxy
   ALLOWED_ORIGIN=https://yourdomain.com
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   GITHUB_REDIRECT_URI=https://yourdomain.com/api/github/callback
   ```
2. In the GitHub OAuth app settings change the **Authorization callback URL** to
   `https://yourdomain.com/api/github/callback`.
3. Terminate TLS at a reverse proxy (e.g. Caddy or Nginx) and forward to port 8787, or
   use a platform that handles HTTPS automatically.

### Provider keys on the internet

Provider API keys are read from the server environment (`server/.env`), never from the
browser, so they stay secret on the deployed machine. Set them in the deployment
platform's secret manager or the `.env` file on the server.
