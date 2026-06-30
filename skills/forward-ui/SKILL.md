---
name: forward-ui
description: Drive the Forward Enterprise web UI for workflows not exposed via REST — topology screenshots, path-search visualization exports, compliance report HTML grabs, exporting the Forward session cookie for other tools. Use when the user asks for "a screenshot of the topology", "export the path diagram", "grab the rendered compliance report", "show me what this looks like in the UI", "export the Forward session cookie". Requires vercel-labs/agent-browser CLI and a one-time `agent-browser auth save forward`. Not for data already in the REST API — use forward-inventory / forward-nqe-query / forward-device-config instead.
allowed-tools: Bash(agent-browser *), Bash(python3 *), Read
---

# Forward UI Driver

> **Read first:** `${CLAUDE_PLUGIN_ROOT}/shared/expertise/forward-as-backend.md` — the foundational framing. The UI is *not* the substrate; the REST API is. Reach for this skill only when the user explicitly wants a rendered artifact (screenshot, PDF, diagram from the live UI) — substrate questions go to the REST-backed skills first.

## Operate as a network engineer

The UI driver is *last resort* for an investigation — when the REST API can't answer the question and the user needs a rendered artifact (diagram, PDF, screenshot). Before reaching here, confirm via `${CLAUDE_PLUGIN_ROOT}/shared/expertise/investigation-workflows.md` that none of the API-driven skills can satisfy the question. UI work is slower, more brittle, and the artifact is the conclusion of an investigation — not its data source.

---

The 95% of what Forward exposes lives in the REST API — use the other skills for that. This skill is for the last 5%: pixel-rendered topology diagrams, PDF path-export flows, UI-only screens, and "log me in so I can take over" hand-offs.

Delegates all browser work to [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser), a native Rust CLI that Claude drives via bash. Zero Python/Node/Playwright deps added to this plugin.

## Prerequisites

Before this skill works, the user must install `agent-browser` and save Forward UI credentials to its local auth vault **once**. If `agent-browser --version` fails, stop and tell the user to run:

```bash
npx skills add vercel-labs/agent-browser   # installs the CLI + its Claude Code skill
agent-browser install                       # downloads Chrome for Testing (only if no Chrome detected)

# URL + username come from env (.env must define FORWARD_API_BASE_URL and FORWARD_UI_USERNAME).
# --password-stdin avoids leaking the secret via shell history or `ps`.
# The USER runs this themselves so their password never transits through Claude.
set -a && source .env && set +a
read -s FWD_PASS && agent-browser auth save forward \
    --url "$FORWARD_API_BASE_URL" \
    --username "$FORWARD_UI_USERNAME" \
    --password-stdin <<< "$FWD_PASS" && unset FWD_PASS
```

**Never type the password into the Claude chat.** If the user hasn't already saved the vault entry, provide the command above and tell them to run it in their shell with a leading `!` or directly in a terminal. Do not attempt to collect the password and execute the command on the user's behalf. If `FORWARD_UI_USERNAME` isn't set in their `.env`, ask them to add it before running the command — don't hardcode a guess.

Then set `FORWARD_API_BASE_URL` (this skill reuses the same env var — Forward's API and UI share a base host). The auth vault name `forward` is a convention this skill assumes; do not rename.

### Domain allowlist (always on)

Every `agent-browser` invocation in this skill passes `--allowed-domains`. This is a security posture choice, not an option: the browser will refuse to navigate or load sub-resources from anything outside the allowlist. The default is derived from `FORWARD_API_BASE_URL`:

    allowed = ${FORWARD_UI_ALLOWED_DOMAINS:-<host>,*.<host>}

If Forward's UI pulls CDN assets from additional hosts (Google Fonts, analytics, per-deployment CDNs), screenshots may render without those assets — text fine, icons/fonts missing. Override with `FORWARD_UI_ALLOWED_DOMAINS="fwd.app,*.fwd.app,fonts.googleapis.com"` in `.env` if that matters.

## When to use

- *"Screenshot the topology for network `<id>`"*
- *"Export the path from A to B as a PDF"*
- *"Grab the rendered compliance report for this snapshot"*
- *"Open Forward and log me in so I can take a look"*
- Anything that requires the rendered UI output, not the underlying data.

## When NOT to use

- Asking about networks/snapshots/devices → `forward-inventory` (REST is faster and free)
- Asking about device state → `forward-device-intel`
- Asking about raw configs → `forward-device-config`
- Tracing reachability as **data** (src/dst/paths/verdicts) → `forward-path-analysis`
  - Use this skill only when the user specifically wants the **rendered visualization**, not the path data.
- Running STIG checks → `forward-compliance-check`

## Invocation

Run from the user's cwd so screenshots and exports land somewhere the user can find them. Do NOT narrate which script you're about to run. All workflows start with login (vault-driven — a few hundred ms when the session is warm).

Every command includes `--allowed-domains`. Compute the value once per workflow and reuse:

```bash
# Paste this setup at the top of any workflow. Yields $AB — a pre-configured
# agent-browser alias — and $FORWARD_HOST for URL-building.
FORWARD_HOST="$(python3 -c 'import os,urllib.parse as u; print(u.urlparse(os.environ["FORWARD_API_BASE_URL"]).netloc)')"
AB_ALLOWED="${FORWARD_UI_ALLOWED_DOMAINS:-$FORWARD_HOST,*.$FORWARD_HOST}"
AB_TLS=""
[ "${FORWARD_INSECURE:-false}" = "true" ] && AB_TLS="--ignore-https-errors"
AB="agent-browser --allowed-domains $AB_ALLOWED $AB_TLS"
```

If `FORWARD_INSECURE=true` is set, `$AB_TLS` adds `--ignore-https-errors` so agent-browser tolerates the same self-signed / internal-CA cert the Python skills are already accepting via `FORWARD_CA_BUNDLE` or `FORWARD_INSECURE`. Chromium uses the system cert store, so the proper on-prem fix is still "install the internal CA root system-wide" — see `SECURITY.md`.

### 1. Topology screenshot

```bash
# (paste the setup block above first)
$AB auth login forward \
  && $AB open "${FORWARD_API_BASE_URL%/}/ui/network/<network-id>" \
  && $AB wait --load networkidle \
  && $AB screenshot "topology-<network-id>.png"
```

If the URL pattern is wrong for this deployment (on-prem Forward may vary), snapshot the landing page and navigate from the visible "Topology" link:

```bash
$AB auth login forward && $AB open "${FORWARD_API_BASE_URL}"
$AB snapshot -i --json    # read the tree, find the ref for the network + topology link
$AB click @<ref>          # navigate by ref, no selector guessing
$AB wait --load networkidle && $AB screenshot "topology.png"
```

### 2. Path-search visualization export

```bash
# (paste the setup block first)
$AB auth login forward \
  && $AB open "${FORWARD_API_BASE_URL%/}/ui/network/<network-id>/path"

# Snapshot to discover the input refs (src-ip, dst-ip, submit button)
$AB snapshot -i --json

# Fill + submit based on snapshot refs Claude identifies (replace @e_src etc.)
$AB fill @e_src "<src-ip>" \
  && $AB fill @e_dst "<dst-ip>" \
  && $AB click @e_submit \
  && $AB wait --load networkidle \
  && $AB screenshot "path-<src>-to-<dst>.png"
```

### 3. Compliance report HTML grab

```bash
# (paste the setup block first)
$AB auth login forward \
  && $AB open "${FORWARD_API_BASE_URL%/}/ui/network/<network-id>/compliance"

$AB wait --load networkidle
$AB snapshot -i --json > /tmp/compliance-tree.json   # structured accessibility tree
$AB screenshot "compliance-<network-id>.png"         # visual for the user
$AB eval "document.body.innerHTML" > "compliance-<network-id>.html"
```

### 4. Hand session to user (headed, no screenshot)

When the user says "open Forward for me" or "let me look at it myself":

```bash
# (paste the setup block first — note --headed flag)
agent-browser --allowed-domains "$AB_ALLOWED" $AB_TLS --headed auth login forward \
  && agent-browser --allowed-domains "$AB_ALLOWED" $AB_TLS --headed open "${FORWARD_API_BASE_URL}"
# then tell the user: "Forward is open in a visible browser window, already logged in. Take over from here."
```

### 5. Export session cookies (for tools that need web-session auth)

When the user or a downstream script needs to hit a Forward endpoint that accepts only the UI session cookie (not the API key):

```bash
# JSON (default) — full metadata
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-ui/scripts/export_session.py"

# Ready for curl -H "Cookie: ..."
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-ui/scripts/export_session.py" \
    --format cookie-header > /tmp/fwd-cookie.txt

# Netscape jar for curl --cookie
python3 "${CLAUDE_PLUGIN_ROOT}/skills/forward-ui/scripts/export_session.py" \
    --format netscape > /tmp/fwd-cookies.jar
curl --cookie /tmp/fwd-cookies.jar "${FORWARD_API_BASE_URL%/}/ui/some/endpoint"
```

The script wraps the setup-block logic internally: derives host, passes `--allowed-domains`, runs `auth login forward`, dumps cookies, filters to Forward host.

## Output format

Never paste accessibility-tree JSON or page HTML into the response. Reference the files you wrote and summarize what's visible.

### Screenshot workflows

```markdown
**<workflow-name>** · network `<id>` · captured in <duration>s

Saved: `./topology-<id>.png` (or the exact path you wrote to)

One-sentence description of what's visible in the screenshot. If you can infer device count, topology shape, or obvious anomalies from the accessibility-tree snapshot you took before the screenshot, mention them. Otherwise just name the file.

Close with a useful next step phrased as a user prompt, e.g. *"To trace a specific flow on this topology, ask: **Can &lt;A&gt; reach &lt;B&gt; in this network?**"* (handled by `forward-path-analysis`).
```

### Hand-session workflows

```markdown
**Forward open in a visible browser** · logged in as `<vault-entry>`

Navigated to `<URL>`. Take over from here.
```

### `export_session.py`

```markdown
**<N> Forward session cookies** exported for host `<host>`

- If `--format json`: summarize cookie count, do NOT paste cookie values (they're secrets). Name the output file/location if you tee'd it somewhere.
- If `--format cookie-header` or `--format netscape`: state where it was written and what format, show an example downstream curl invocation. Never echo the raw value.
- If zero cookies came back: point out that login likely failed silently; suggest `agent-browser auth delete forward` and have the user re-run the `auth save` command from **Prerequisites` to reset the vault entry.
```

### Error responses

- `agent-browser: command not found` → tell user to run the three install commands in **Prerequisites**, do NOT attempt to install it yourself.
- Login failures (timeout waiting for form, wrong creds) → surface the stderr message verbatim and suggest `agent-browser auth delete forward` and have the user re-run the `auth save` command from **Prerequisites` to reset.
- Unknown URL / 404 → fall back to snapshot-then-navigate pattern (workflow 1's fallback).
- Empty cookie export → vault creds may be wrong; do not paste partial output, just report the zero count.

## Security

Read `SECURITY.md` §*Forward UI credentials* before running this skill in production. Key points:

- **UI creds are a different blast radius from the API key.** A full-user Forward UI account can do things the read-only API key can't. Use a dedicated **viewer/read-only** Forward UI account for automation.
- **Allowlist is always on.** Every workflow in this skill passes `--allowed-domains`; do not bypass this.
- **Exported cookies are secrets.** Treat them like passwords — write to `/tmp/` with `chmod 600` for the user's session, delete when done, never paste into chat output.
- Auth vault entries are locally encrypted. An attacker with local access to the workstation can still exfiltrate them — same risk as an `.env` file, no worse.
- For headed sessions handed to the user, the browser stays open until the user closes it — session hijacking risk if the workstation is left unattended.

## Gotchas

- **URL schemes are deployment-specific.** `fwd.app` uses `https://fwd.app/ui/network/{id}/...`. On-prem deployments may use different paths. When a URL 404s, fall back to the snapshot-then-navigate pattern — don't guess new URLs.
- **Forward's SPA re-renders on route change** without a hard navigation. `wait --load networkidle` is necessary after `click` when the URL changes; otherwise you'll screenshot the previous view.
- **Topology graphs can take 5–15s to settle** for large networks (50+ devices, lots of links). Consider `wait --sleep 5` after `networkidle` if the first screenshot shows animation mid-flight.
- **Auth vault is machine-local.** If the user runs this on a different machine, they need to re-`add` their creds there. Same as `.env` — not a sync story.
- **Session timeouts.** Forward's UI sessions typically expire after 30–60 minutes of inactivity. The vault-driven `auth login` re-runs the form, so this is automatic; you just pay a couple of seconds each time.
- **`agent-browser eval` runs arbitrary JavaScript.** Gated behind `--confirm-actions eval` for hardened deployments — if the user has that enabled, prompt them.
- **Don't scrape data that the REST API already exposes.** It's slower, more brittle, and defeats the point of the other skills. If a user asks for device counts or interface state, redirect to `forward-inventory` / `forward-device-intel`.
- **Cookie format quirks**. `export_session.py` tolerates both `[{...}, ...]` and `{"cookies": [...]}` shapes from `agent-browser --json cookies`. If the CLI ever returns something else, the script emits `# unexpected cookies payload shape` and exits non-zero — paste that stderr to debug.
- **Cookies expire**. Forward's session TTL is typically 30-60 min. Re-run `export_session.py` if downstream requests start returning 401/302-to-login.
