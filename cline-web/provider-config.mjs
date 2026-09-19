/**
 * Vertex provider config for the Cline SDK -- kept inside this project.
 *
 * WHY THIS FILE EXISTS
 * The SDK resolves the Vertex project/region from its *provider settings
 * store*, NOT from the config object handed to ClineCore.start(): `config.gcp`
 * is dropped on the way to the transport. The store defaults to
 *   ~/.cline/data/settings/providers.json          (shared with Cline IDE/CLI)
 * and when the `vertex` entry is missing the SDK falls back to its apiKeyEnv
 * candidates, producing a request with no project and a bogus
 * `x-goog-api-key` header:
 *   POST .../v1beta1/publishers/google/models/<model>:streamGenerateContent
 *   => HTTP 401 "API keys are not supported by this API..."
 *
 * WHAT THIS DOES
 * 1. Points the SDK's state directory at `<repo>/cline-web/.cline-local` via
 *    CLINE_DATA_DIR, so its settings/sessions/db/logs live here instead of in
 *    the global ~/.cline. Override CLINE_DATA_DIR or CLINE_DIR to opt out.
 * 2. Makes sure the store contains a `vertex` entry matching VERTEX_PROJECT /
 *    VERTEX_REGION / model, so the OAuth path is always used.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ProviderSettingsManager } from "@cline/sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Local SDK state dir; must be applied before any ProviderSettingsManager. */
export const LOCAL_DATA_DIR = path.join(HERE, ".cline-local");
if (!process.env.CLINE_DATA_DIR && !process.env.CLINE_DIR) {
  process.env.CLINE_DATA_DIR = LOCAL_DATA_DIR;
}

export const VERTEX_PROJECT = process.env.VERTEX_PROJECT || "[project_ID]";
export const VERTEX_REGION = process.env.VERTEX_REGION || "us-central1";
export const VERTEX_MODEL =
  process.env.VERTEX_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** The provider settings entry the SDK's vertex transport needs. */
export function vertexTargetSettings(model = VERTEX_MODEL) {
  return {
    provider: "vertex",
    model,
    gcp: { projectId: VERTEX_PROJECT, region: VERTEX_REGION },
  };
}

/** True when `file` (default: the active store) lives inside this project. */
export function isLocalStore(file) {
  const p = file || new ProviderSettingsManager().getFilePath();
  return path.resolve(p).startsWith(HERE + path.sep);
}

/**
 * Idempotently ensure the store has a `vertex` entry for our target.
 * Returns { file, wrote, isLocal, settings }. Never touches other providers.
 */
export function ensureVertexSettings(model = VERTEX_MODEL) {
  const mgr = new ProviderSettingsManager();
  const file = mgr.getFilePath();
  const want = vertexTargetSettings(model);
  const have = mgr.getProviderSettings("vertex");

  const upToDate =
    have &&
    have.model === want.model &&
    have.gcp?.projectId === want.gcp.projectId &&
    have.gcp?.region === want.gcp.region;

  if (upToDate) {
    return { file, wrote: false, isLocal: isLocalStore(file), settings: have };
  }
  // setLastUsed:false so we never hijack the IDE/CLI's default provider.
  mgr.saveProviderSettings(want, { setLastUsed: false });
  return { file, wrote: true, isLocal: isLocalStore(file), settings: want };
}

/** One-line description of where the SDK will read/write its state. */
export function describeStore(file) {
  const p = file || new ProviderSettingsManager().getFilePath();
  const where = isLocalStore(p) ? "local" : `global (~${path.sep}${path.relative(os.homedir(), p).split(path.sep)[0]})`;
  return `${where}: ${p}`;
}