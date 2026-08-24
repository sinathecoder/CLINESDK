# Cline SDK × Gemini — Web Coding Agent

A web UI that takes a prompt (plus an optional **project .zip** or **GitHub
repo**) and runs the **full Cline SDK harness** (`ClineCore`) connected to
**Google Gemini** in native **act mode**, autonomously making changes — then
hands you the result back as a downloadable zip, a pushed branch, or a PR.

## How it runs

```js
const cline = await ClineCore.create({ clientName, backendMode: "local" });
await cline.start({
  config: {
    providerId: "gemini", modelId, apiKey,
    cwd: projectDir, workspaceRoot: projectDir,
    mode: "act",                 // native Cline act mode
    enableTools: true, maxIterations: 60,
  },
  localRuntime: { extraTools: gitAndGithubTools },
  toolPolicies: { "*": { autoApprove: true } },   // headless sandbox
});
await cline.send({ sessionId, prompt, mode: "act" });
```

This is the same runtime the Cline CLI/IDE use (`ClineCore`, not the stateless
loop), so you get its real act-mode execution: built-in file/shell/search tools
plus our git extras, streaming events, session transcripts.

## Three ways to use it

1. **From scratch** — type a prompt; the agent builds a new project in the sandbox.
2. **Upload a project zip** — upload → agent modifies it → **⬇ Download zip**.
3. **GitHub repo** — `clone_repo` → changes → branch → `push_branch` → `create_pull_request`.

## Zip workflow

```
choose .zip ──▶ POST /api/upload?name=myproj     (staged to tmp, unpacked to workspace/myproj)
type prompt ──▶ POST /api/run { folder:"myproj" } (agent workspace scoped to that folder)
⬇ Download ──▶ GET /api/download?folder=myproj    (myproj-modified.zip, cache junk excluded)
```

## Files

- `server.mjs` — HTTP server + ClineCore session runner (`/api/run` SSE,
  `/api/upload`, `/api/download`, `/api/files`)
- `tools.js` — git/GitHub extra tools via SDK `createTool`: `clone_repo`,
  `git_status`, `git_diff`, `create_branch`, `commit_changes`, `push_branch`,
  `create_pull_request`
- `public/index.html` — the web UI
- `test-agent.mjs` — stateless-Agent smoke test

## Setup & run

```bash
cd cline-web
export PATH="$HOME/node22/node-v22.14.0-darwin-arm64/bin:$PATH"   # Node 22+
npm install @cline/sdk          # already installed here
export GEMINI_API_KEY='AIza...'
export AGENT_WORKSPACE=workspace
npm start                        # → http://127.0.0.1:5001
```

## GitHub PR workflow (optional)

Provide a GitHub token (**Contents: read/write** + **Pull requests: read/write**)
via `GITHUB_TOKEN`. The agent then runs `clone_repo` → edits → `create_branch`
→ `commit_changes` → `push_branch` → `create_pull_request` and returns the PR URL.

## Security notes

- Everything is confined to `AGENT_WORKSPACE` (path traversal blocked); each
  uploaded project gets its own folder and the session is scoped to it.
- Act mode auto-approves tools inside the sandbox (`toolPolicies` +
  `requestToolApproval`) — trusted-input only; add an OS-level sandbox for
  untrusted users.
- Never commit `GEMINI_API_KEY` or your GitHub token.

