/**
 * Winston logger for the Cline SDK web agent.
 *
 * Provides a single, configurable logger writing to:
 *   - the console (human-readable, colorized), and
 *   - a rotating JSON file under ./logs (or $LOG_DIR) for auditing/debugging.
 *
 * Configuration (all optional environment variables):
 *   LOG_DIR      - directory for file logs   (default: ./logs inside this repo)
 *   LOG_LEVEL    - min level: error|warn|info|http|verbose|debug|silly (default: http,
 *                  so HTTP request logs are shown by default; use info for a quieter run)
 *   LOG_CONSOLE  - set to "0" to disable the console transport
 *   LOG_FILE     - set to "0" to disable the file transport
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import winston from "winston";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Resolve settings from the environment ---------------------------------
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, "logs"));
const LOG_LEVEL = process.env.LOG_LEVEL || "http";
const ENABLE_CONSOLE = process.env.LOG_CONSOLE !== "0";
const ENABLE_FILE = process.env.LOG_FILE !== "0";

// ---- Shared formats --------------------------------------------------------
// JSON format used by the file transport (structured, easy to ingest).
const jsonFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json(),
);

// Human-readable format used by the console transport.
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const rest = Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : "";
    return `${timestamp} ${level}: ${message}${rest}`;
  }),
);

// ---- Build the file transport ---------------------------------------------
const transportList = [];
const fileTransport = ENABLE_FILE
  ? new winston.transports.File({
      filename: path.join(LOG_DIR, "app.log"),
      format: jsonFormat,
      // Rotate the file once it reaches ~5 MB, keep 3 rotated copies.
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    })
  : null;

if (fileTransport) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  transportList.push(fileTransport);
}

if (ENABLE_CONSOLE) {
  transportList.push(new winston.transports.Console({ format: consoleFormat }));
}

// ---- The logger ------------------------------------------------------------
/**
 * The shared application logger.
 *
 *   import logger from "./logger.mjs";
 *   logger.info("message");
 *   logger.error("failed", { err, taskId });
 */
export const logger = winston.createLogger({
  level: LOG_LEVEL,
  transports: transportList,
  // Keep the process alive even if a transport errors.
  exitOnError: false,
});

/** Change the minimum level the logger emits at runtime. */
export function setLogLevel(level) {
  if (typeof level === "string") logger.level = level;
}

/** The resolved directory the logger writes JSON files to. */
export function logDirectory() {
  return LOG_DIR;
}

export default logger;