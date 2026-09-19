/**
 * Cline x Gemini Web Agent — backend.
 *
 * Serves a small web UI and streams a Cline SDK Agent run back to the browser
 * as Server-Sent Events. The Agent is backed by Google Gemini (providerId
 * "gemini") and can act + build code in a sandboxed workspace via tools.
 *
 * Run:
 *   export GEMINI_API_KEY='AIza...'
 *   AGENT_WORKSPACE=workspace node server.mjs
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ClineCore } from "@cline/sdk";
import {
  tools, workspaceRoot, fileTree, setWorkspaceRoot, resetWorkspaceRoot,
} from "./tools.js";
import logger, { logDirectory } from "./logger.mjs";
import {
  ensureVertexSettings, describeStore, VERTEX_PROJECT, VERTEX_REGION, VERTEX_MODEL,
} from "./provider-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const API_KEY = process.env.GEMINI_API_KEY || "";

// Vertex target comes from provider-config.mjs (defaults: [project_ID] /
// us-central1 / gemini-2.5-flash, overridable via VERTEX_* in .env).
const DEFAULT_MODEL = VERTEX_MODEL;

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Folder names allowed inside the workspace (no traversal, no hidden paths). */
function sanitizeFolder(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  if (!/^[\w][\w.-]{0,63}$/.test(n) || n.includes("..")) return "";
  return n;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  try { walk(dir); } catch (err) { throw err; }
  return n;
}

/**
 * Runs the task through the full ClineCore harness (the same runtime the
 * Cline CLI/IDE use) in native ACT mode, with the SDK's built-in tools
 * (read/write/edit files, run commands, search) plus our git/GitHub extras.
 * Progress is relayed to the browser via `send`.
 */
async function runAgent({ task, model, apiKey, send, workspaceDir }) {
  send({ t: "status", msg: `Starting ClineCore session (act mode, model ${model})...` });

  const cline = await ClineCore.create({
    clientName: "cline-gemini-web",
    backendMode: "local",
    // Headless web app: auto-approve tool use inside the sandboxed workspace.
    capabilities: {
      requestToolApproval: async () => ({ approved: true }),
    },
  });

  let lastAssistantText = "";
  // Set when the agent emits an error event; thrown after send() so the
  // try/catch below re-throws and the run is marked failed.
  let runError = null;
  const unsubscribe = cline.subscribe((event) => {
    if (event.type !== "agent_event") return;
    const ev = event.payload.event;
    switch (ev.type) {
      case "content_start":
        if (ev.contentType === "text" && ev.text) {
          lastAssistantText += ev.text;
          send({ t: "text", text: ev.text });
        }
        if (ev.contentType === "tool" && ev.toolName) {
          send({ t: "tool_call", name: ev.toolName, input: ev.input ?? {} });
        }
        break;
      case "content_update":
        if (ev.contentType === "tool") {
          send({ t: "tool_update", name: ev.toolName, update: ev.update });
        }
        break;
      case "content_end":
        if (ev.contentType === "tool" && ev.toolName) {
          if (ev.error) {
            logger.error("tool error", { tool: ev.toolName, error: ev.error?.message || String(ev.error), stack: ev.error?.stack });
            send({ t: "tool_result", name: ev.toolName, error: ev.error });
          }
          else send({ t: "tool_result", name: ev.toolName, output: ev.output });
        }
        break;
      case "notice":
        send({ t: "status", msg: ev.message });
        break;
      case "usage":
        send({ t: "usage", usage: ev });
        break;
      case "error":
        const agentErr = ev.error?.message ? ev.error : new Error(String(ev.error));
        logger.error("agent error", { error: agentErr.message, stack: agentErr.stack || "" });
        runError = agentErr;
        send({ t: "error", message: agentErr.message });
        break;
    }
  });

  let sessionId;
  try {
    const started = await cline.start({
      source: "web",
      interactive: false,
      config: {
        providerId: "vertex",
        modelId: DEFAULT_MODEL,
        // Vertex project/region. IMPORTANT: the SDK's Vertex transport reads
        // these from the provider settings store
        // (~/.cline/data/settings/providers.json -> providers.vertex.gcp), NOT
        // from this config object -- config.gcp is dropped by the resolver.
        // `node test-vertex.mjs` writes and verifies that entry.

        workspaceRoot: workspaceDir,
        mode: "act",                    // ← native Cline act mode
        maxIterations: 60,
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        disableMcpSettingsTools: true,
        systemPrompt:
          "You are Cline, an autonomous coding agent acting on a project in your " +
          "workspace. Use the built-in tools to inspect, create, edit and run code. " +
          "Work autonomously until the task is done, verifying as you go, then give " +
          "a concise summary of what changed and how to run it.",
      },
      localRuntime: {
        extraTools: tools,              // git / GitHub PR tools on top of built-ins
      },
      // Act mode headless: auto-approve every tool inside the sandbox.
      toolPolicies: { "*": { autoApprove: true } },
    });
    sessionId = started.sessionId;

    await cline.send({ sessionId, prompt: task, mode: "act" });

    // If the agent emitted an error event, surface it as a thrown exception so
    // the catch below logs it, re-throws, and the run is marked failed.
    if (runError) throw runError;

    // Pull the final transcript for a reliable summary text.
    try {
      const msgs = await cline.readDisplayMessages(sessionId);
      const assistant = msgs
        .filter((m) => m.role === "assistant")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : (m.content || []).map((p) => p?.text || "").join(""),
        );
      const tail = assistant.filter(Boolean).slice(-3).join("\n\n").trim();
      if (tail) lastAssistantText = tail;
    } catch (err) {
      logger.error("transcript read failed", { error: err?.message || String(err), stack: err?.stack || "" });
      throw err;
    }

    send({ t: "done", status: "completed", outputText: lastAssistantText });
    send({ t: "final", status: "completed" });
  } catch (err) {
    logger.error("agent run error", { error: err?.message || String(err), stack: err?.stack || "" });
    send({ t: "error", message: String(err.message || err) });
    send({ t: "final", status: "failed" });
    throw err; // propagate so the caller marks the stream as failed
  } finally {
    unsubscribe?.();
    if (sessionId) await cline.stop(sessionId).catch((cleanupErr) => { throw cleanupErr; });
    await cline.dispose().catch((cleanupErr) => { throw cleanupErr; });
  }
}

const server = http.Server(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  if (req.method === "GET" && (route === "/" )) {
    let html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
    html = html.split("__DEFAULT_MODEL__").join(DEFAULT_MODEL);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && route === "/api/files") {
    const body = JSON.stringify(fileTree());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
    return;
  }

  // ---- Upload a project as .zip -> unpacked into the workspace -------------
  if (req.method === "POST" && route === "/api/upload") {
    const folder = sanitizeFolder(url.searchParams.get("name") || "");
    if (!folder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing ?name=<folder> for the project" }));
      return;
    }
    const destDir = path.join(workspaceRoot(), folder);
    // Replace any previous upload with the same name so re-uploads just work.
    fs.rmSync(destDir, { recursive: true, force: true });
    const tmpZip = path.join(os.tmpdir(), `cline-upload-${Date.now()}.zip`);
    const buf = await readBody(req);
    if (!buf || buf.length < 22) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "empty or invalid zip upload" }));
      return;
    }
    fs.writeFileSync(tmpZip, buf);
    fs.mkdirSync(destDir, { recursive: true });
    // -o overwrite, -q quiet; unzip guards against absolute paths but we also
    // verify afterwards that nothing escaped the destination.
    const up = spawnSync("unzip", ["-oq", tmpZip, "-d", destDir], { encoding: "utf8" });
    fs.unlinkSync(tmpZip);
    const out = (up.stdout || "") + (up.stderr || "");
    if (up.status !== 0) {
      fs.rmSync(destDir, { recursive: true, force: true });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unzip failed: ${out.trim()}` }));
      return;
    }
    const count = countFiles(destDir);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "uploaded", folder, files: count }));
    return;
  }

  // ---- Download a workspace folder back as .zip ----------------------------
  if (req.method === "GET" && route === "/api/download") {
    const folder = sanitizeFolder(url.searchParams.get("folder") || "");
    if (!folder) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing ?folder=<name>" }));
      return;
    }
    const src = path.join(workspaceRoot(), folder);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `folder '${folder}' not found in workspace` }));
      return;
    }
    const tmpZip = path.join(os.tmpdir(), `cline-dl-${Date.now()}.zip`);
    // -r recursive, -q quiet; run inside the folder so paths are relative.
    // Exclude build/cache junk the agent may have produced while testing.
    const zp = spawnSync(
      "zip",
      ["-rq", path.basename(tmpZip), ".",
       "-x", "*.pyc", "*/__pycache__/*", "__pycache__/*",
       "*/node_modules/*", "node_modules/*", "*/.git/*"],
      { cwd: src, encoding: "utf8" },
    );
    if (zp.status !== 0) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "failed to create zip" }));
      return;
    }
    const zpath = path.join(src, path.basename(tmpZip));
    const data = fs.readFileSync(zpath);
    fs.unlinkSync(zpath);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${folder}-modified.zip"`,
      "content-length": data.length,
    });
    res.end(data);
    return;
  }

  if (req.method === "POST" && route === "/api/run") {
    const rawBuf = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(rawBuf.toString("utf8") || "{}");
    } catch (err) {
      logger.error("json parse error", { error: err?.message || String(err), stack: err?.stack || "" });
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `invalid JSON body: ${String(err?.message || err)}` }));
      throw err;
    }
    const taskInput = (body.task || "").trim();
    const model = body.model || DEFAULT_MODEL;
    const apiKey = body.key || API_KEY;
    const ghToken = body.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    if (ghToken) process.env.GH_TOKEN = ghToken;   // tools read this for push + PR
    if (body.repoUrl) process.env.CLINE_REPO_URL = body.repoUrl;

    // When working on an uploaded project, scope the agent's workspace to that
    // folder so tools see project files at the root (no folder prefix needed).
    let task = taskInput;
    const projectFolder = sanitizeFolder(body.folder || "");
    if (projectFolder) {
      const scoped = path.join(workspaceRoot(), projectFolder);
      if (!fs.existsSync(scoped) || !fs.statSync(scoped).isDirectory()) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: `folder '${projectFolder}' not found in workspace — upload the project zip first`,
        }));
        return;
      }
      setWorkspaceRoot(scoped);
      task =
        `You are working on an existing project that is already present at the root of ` +
        `your workspace. Read, edit, run and verify code there; keep all paths relative ` +
        `to the project root. Do not create a new project elsewhere.\n\n` +
        `Task: ${taskInput}`;
    }

    if (!task) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "prompt is empty" }));
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.flushHeaders();

    const send = (ev) => {
      res.write(sse(ev));
    };

    // Where the agent works: the uploaded project folder if provided,
    // otherwise the base workspace root.
    const workspaceDir = projectFolder
      ? path.join(workspaceRoot(), projectFolder)
      : workspaceRoot();

    try {
      await runAgent({ task, model, apiKey, send, workspaceDir });
      send({ t: "stream_end", ok: true });
      logger.info("agent run completed", { workspaceDir, model });
    } catch (err) {
      logger.error("agent run failed", { workspaceDir, error: err?.message || String(err), stack: err?.stack || "" });
      send({ t: "error", message: String(err.message || err) });
      send({ t: "stream_end", ok: false });
      throw err; // re-throw so the error is not silently swallowed
    } finally {
      resetWorkspaceRoot();  // never leak the project scope into other requests
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 5001);
server.on("error", (err) => {
  logger.error("server error", { error: String(err?.message || err) });
});
server.on("clientError", (err, socket) => {
  logger.warn("client error", { error: String(err?.message || err) });
  socket?.destroy();
});
// Make sure the SDK's provider settings store contains the `vertex` entry its
// transport needs. Without it the SDK builds a project-less request and sends
// an x-goog-api-key, which Vertex rejects with a confusing HTTP 401
// ("API keys are not supported by this API").
try {
  const store = ensureVertexSettings();
  logger.info(
    `Provider config -> ${describeStore(store.file)}${store.wrote ? " (written)" : ""}`,
  );
} catch (err) {
  logger.warn("could not ensure vertex provider settings", {
    error: String(err?.message || err),
  });
}

server.listen(PORT, HOST, () => {
  logger.info(`Cline SDK web agent -> http://${HOST}:${PORT}`);
  logger.info(`Workspace -> ${workspaceRoot()}`);
  logger.info(`Log file  -> ${logDirectory()}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}