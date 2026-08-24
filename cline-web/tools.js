/**
 * Sandboxed tools for the Cline SDK agent.
 *
 * The Cline Agent executes these tools when the model decides to. Every path
 * operation is confined to AGENT_WORKSPACE so the agent builds code there and
 * never touches files outside it. Shell runs inside the workspace with a
 * timeout.
 */
import { createTool } from "@cline/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 512_000;

// When set, all tools operate inside this directory instead of the base
// workspace. Used to scope an agent run to an uploaded project folder.
let workspaceOverride = null;

/** Scope all tools to a specific directory (used for uploaded projects). */
export function setWorkspaceRoot(dir) {
  workspaceOverride = path.resolve(dir);
  fs.mkdirSync(workspaceOverride, { recursive: true });
  return workspaceOverride;
}

/** Clear the scope so tools operate on the base workspace again. */
export function resetWorkspaceRoot() {
  workspaceOverride = null;
}

export function workspaceRoot() {
  const root = path.resolve(
    workspaceOverride ||
    process.env.AGENT_WORKSPACE ||
    path.join(process.cwd(), "workspace"),
  );
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function resolveInside(rel) {
  const root = workspaceRoot();
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path refuses outside workspace: ${rel}`);
  }
  return target;
}

function relOf(root, target) {
  if (target === root) return "/";
  return target.slice(root.length).replace(/\\/g, "/");
}

function listTree(dir, prefix) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  } catch {
    return [{ path: prefix || "/", type: "dir", note: "permission denied" }];
  }
  for (const e of entries.slice(0, 500)) {
    const childPath = path.join(dir, e.name);
    const rel = prefix ? `${prefix}/${e.name}` : `/${e.name}`;
    if (e.isDirectory()) {
      out.push({ path: rel, type: "dir" });
      out.push(...listTree(childPath, rel));
    } else {
      let size = 0;
      try { size = fs.statSync(childPath).size; } catch {}
      out.push({ path: rel, type: "file", size });
    }
  }
  return out;
}

/**
 * Run a shell command WITHOUT blocking the Node event loop (async spawn).
 * Long commands like `docker build` would otherwise freeze the whole server.
 */
function runCommand(command) {
  const root = workspaceRoot();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const cp = spawn(command, {
      cwd: root,
      shell: true,
      timeout: 300_000,   // auto-kill after 5 min
      encoding: "utf8",
    });
    cp.stdout?.on("data", (d) => { stdout += d; });
    cp.stderr?.on("data", (d) => { stderr += d; });
    cp.on("error", (err) => {
      resolve({ command, exit_code: 1, output: String(err.message || err) });
    });
    cp.on("close", (code, signal) => {
      const out = ((stdout || "") + (stderr || "")).slice(-12000);
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        resolve({ command, error: "command timed out after 300s", output: out });
      } else {
        resolve({ command, exit_code: code ?? 1, output: out });
      }
    });
  });
}

// ---- GitHub / git helpers -------------------------------------------------

let ghGitConfigured = false;

function ghEnv() {
  const env = { ...process.env };
  if (githubToken()) env.GH_TOKEN = githubToken();
  return env;
}

function githubToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

/** Run a git command inside a specific repo directory in the workspace. */
function runGit(repo, args, timeoutMs = 60_000) {
  const dir = repoDir(repo);
  const cp = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: timeoutMs });
  const out = (cp.stdout || "") + (cp.stderr || "");
  const code = typeof cp.status === "number" ? cp.status : 1;
  return { exit_code: code, output: out.trim() };
}

/** Resolve a repo directory inside the workspace and verify it is a git repo. */
function repoDir(repo) {
  const rel = (repo || ".").trim();
  const target = path.resolve(workspaceRoot(), rel);
  const root = workspaceRoot();
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing path outside workspace: ${repo}`);
  }
  if (!fs.existsSync(path.join(target, ".git"))) {
    throw new Error(`'${rel}' is not a git repository (clone it first with clone_repo)`);
  }
  return target;
}

/** One-time: let git push over HTTPS using the GitHub token via gh's helper. */
function ensureGitCredentialHelper() {
  if (ghGitConfigured || !githubToken()) return;
  const cp = spawnSync("gh", ["auth", "setup-git"], { encoding: "utf8", env: ghEnv() });
  ghGitConfigured = cp.status === 0;
}

/** owner/name from a git remote or URL. */
function parseOwnerRepo(repo) {
  const dir = repoDir(repo);
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8" });
  const url = (r.stdout || "").trim();
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  if (!m) throw new Error(`Cannot determine GitHub owner/repo from remote: ${url}`);
  return m[1];
}

export function fileTree() {
  const root = workspaceRoot();
  return { workspace: root, entries: listTree(root, "") };
}

export const tools = [
  createTool({
    name: "list_files",
    description: "List the files/directories currently in the workspace (recursively).",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "Optional directory prefix within the workspace (default /).",
        },
      },
    },
    execute({ prefix }) {
      const root = workspaceRoot();
      const target = prefix && prefix !== "/" ? path.resolve(root, prefix) : root;
      if (target !== root && !target.startsWith(root + path.sep)) {
        return { error: "path escapes workspace" };
      }
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        return { path: relOf(root, target), type: "file" };
      }
      if (!fs.existsSync(target)) return { error: "path not found" };
      return { workspace: root, entries: listTree(target, "") };
    },
  }),

  createTool({
    name: "read_file",
    description: "Read and return the text content of a file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the workspace." },
      },
      required: ["path"],
    },
    execute({ path: rel }) {
      try {
        const target = resolveInside(rel);
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
          return { error: `file not found: ${rel}` };
        }
        const size = fs.statSync(target).size;
        if (size > MAX_FILE_BYTES) return { error: `file too large (${size} bytes)` };
        return { path: rel, bytes: size, content: fs.readFileSync(target, "utf8") };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    },
  }),

  createTool({
    name: "write_file",
    description: "Create or overwrite a text file in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Destination path, relative to the workspace." },
        content: { type: "string", description: "Full text content to write." },
      },
      required: ["path", "content"],
    },
    execute({ path: rel, content }) {
      try {
        const target = resolveInside(rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, "utf8");
        return { path: rel, status: "written", bytes: Buffer.byteLength(content, "utf8") };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    },
  }),

  createTool({
    name: "patch_file",
    description: "Replace the exact first occurrence of `old` with `new` in an existing file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace." },
        old: { type: "string", description: "Exact substring to replace." },
        new: { type: "string", description: "Replacement substring." },
      },
      required: ["path", "old", "new"],
    },
    execute({ path: rel, old: findText, new: replacement }) {
      try {
        const target = resolveInside(rel);
        if (!fs.existsSync(target)) return { error: `file not found: ${rel}` };
        const text = fs.readFileSync(target, "utf8");
        const idx = text.indexOf(findText);
        if (idx === -1) return { error: "old text not found (include exact context)" };
        const updated = text.slice(0, idx) + replacement + text.slice(idx + findText.length);
        fs.writeFileSync(target, updated, "utf8");
        return { path: rel, status: "patched", bytes: Buffer.byteLength(updated, "utf8") };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    },
  }),

  createTool({
    name: "execute_command",
    description: "Run a shell command inside the workspace and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run inside the workspace." },
      },
      required: ["command"],
    },
    async execute({ command }) {
      if (!command || !command.trim()) return { error: "empty command" };
      return runCommand(command);
    },
  }),

  createTool({
    name: "clone_repo",
    description:
      "Clone a GitHub repository into the workspace. Do this first before changing a repo.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Repo URL (https://github.com/owner/repo.git) or shorthand owner/repo.",
        },
        name: {
          type: "string",
          description: "Optional folder name inside the workspace (defaults to the repo name).",
        },
      },
      required: ["url"],
    },
    execute({ url, name }) {
      try {
        let target = (url || "").trim();
        if (/^[\w.-]+\/[\w.-]+$/.test(target)) target = `https://github.com/${target}.git`;
        const folder = (name || target.split("/").pop().replace(/\.git$/, "")).trim();
        const dest = path.join(workspaceRoot(), folder);
        if (fs.existsSync(dest)) return { error: `folder already exists: ${folder}` };
        const cp = spawnSync("git", ["clone", "--depth", "50", target, dest], {
          encoding: "utf8", timeout: 180_000,
        });
        const out = (cp.stdout || "") + (cp.stderr || "");
        if (cp.status !== 0) return { error: `clone failed: ${out.trim()}` };
        return { status: "cloned", repo: folder, output: out.trim() };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    },
  }),

  createTool({
    name: "git_status",
    description: "Show git status (branch + changed files) and recent log for a repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo folder name inside the workspace." },
      },
      required: ["repo"],
    },
    execute({ repo }) {
      try {
        const st = runGit(repo, ["status", "--short", "--branch"]);
        const lg = runGit(repo, ["log", "--oneline", "-5"]);
        return { status: st.output, exit_code: st.exit_code, recent_log: lg.output };
      } catch (err) { return { error: String(err.message || err) }; }
    },
  }),

  createTool({
    name: "git_diff",
    description: "Show the current uncommitted diff in a repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo folder name inside the workspace." },
      },
      required: ["repo"],
    },
    execute({ repo }) {
      try {
        const d = runGit(repo, ["diff", "HEAD"]);
        return d.output ? { diff: d.output.slice(0, 20_000) } : { note: "no uncommitted changes" };
      } catch (err) { return { error: String(err.message || err) }; }
    },
  }),

  createTool({
    name: "create_branch",
    description: "Create and switch to a new git branch in a repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo folder name inside the workspace." },
        branch: { type: "string", description: "New branch name, e.g. feat/add-todo-api." },
      },
      required: ["repo", "branch"],
    },
    execute({ repo, branch }) {
      try {
        if (!/^[\w./-]+$/.test(branch)) return { error: "invalid branch name" };
        ensureGitCredentialHelper();
        const r = runGit(repo, ["checkout", "-b", branch]);
        if (r.exit_code !== 0) return { error: r.output };
        return { status: "branch created and checked out", branch };
      } catch (err) { return { error: String(err.message || err) }; }
    },
  }),

  createTool({
    name: "commit_changes",
    description: "Stage all changes and create a git commit in a repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo folder name inside the workspace." },
        message: { type: "string", description: "Commit message." },
      },
      required: ["repo", "message"],
    },
    execute({ repo, message }) {
      try {
        if (!message || !message.trim()) return { error: "empty commit message" };
        ensureGitCredentialHelper();
        const add = runGit(repo, ["add", "-A"]);
        if (add.exit_code !== 0) return { error: add.output };
        const cp = spawnSync("git", ["commit", "-m", message], {
          cwd: repoDir(repo), encoding: "utf8", timeout: 60_000,
          env: { ...process.env,
                 GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Cline Agent",
                 GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "agent@cline.local",
                 GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Cline Agent",
                 GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "agent@cline.local" },
        });
        const out = (cp.stdout || "") + (cp.stderr || "");
        if (cp.status !== 0) return { error: out.trim() };
        const head = runGit(repo, ["log", "-1", "--oneline"]);
        return { status: "committed", commit: head.output };
      } catch (err) { return { error: String(err.message || err) }; }
    },
  }),

  createTool({
    name: "push_branch",
    description:
      "Push the current branch to origin (GitHub). Needs a GitHub token with push access.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo folder name inside the workspace." },
        branch: { type: "string", description: "Branch name to push." },
      },
      required: ["repo", "branch"],
    },
    execute({ repo, branch }) {
      try {
        if (!/^[\w./-]+$/.test(branch)) return { error: "invalid branch name" };
        ensureGitCredentialHelper();
        const r = runGit(repo, ["push", "-u", "origin", branch], 120_000);
        if (r.exit_code !== 0) {
          return { error: `push failed: ${r.output}`,
                   hint: "check that your GitHub token has push (contents:write) access to this repo" };
        }
        return { status: "pushed", branch };
      } catch (err) { return { error: String(err.message || err) }; }
    },
  }),

  createTool({
    name: "create_pull_request",
    description:
      "Open a GitHub pull request from a pushed branch. Call only after push_branch succeeds.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo folder name inside the workspace." },
        branch: { type: "string", description: "Head branch (the one you pushed)." },
        base: { type: "string", description: "Base branch to merge into (default: main)." },
        title: { type: "string", description: "PR title." },
        body: { type: "string", description: "PR description in markdown." },
      },
      required: ["repo", "branch", "title"],
    },
    execute({ repo, branch, base, title, body }) {
      try {
        if (!githubToken()) {
          return { error: "no GitHub token configured — add one in the UI to open PRs" };
        }
        ensureGitCredentialHelper();
        const owner = parseOwnerRepo(repo);
        const args = ["pr", "create", "--repo", owner, "--head", branch,
                      "--title", title, "--body", body || title];
        if (base) args.push("--base", base);
        const cp = spawnSync("gh", args, {
          encoding: "utf8", timeout: 60_000, env: ghEnv(),
        });
        const out = (cp.stdout || "") + (cp.stderr || "");
        if (cp.status !== 0) return { error: out.trim() };
        const url = (out.match(/https:\/\/github\.com\/\S+/) || [out.trim()])[0];
        return { status: "pull request created", url, owner_repo: owner, head: branch, base: base || "main" };
      } catch (err) { return { error: String(err.message || err) }; }
    },
  }),
];