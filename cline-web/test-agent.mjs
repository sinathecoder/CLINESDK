import { Agent } from "@cline/sdk";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error("need GEMINI_API_KEY"); process.exit(1); }

const agent = new Agent({
  providerId: "gemini",
  modelId: process.argv[2] || "gemini-3.6-flash",
  apiKey,
  maxIterations: 2,
  temperature: 0.2,
  systemPrompt: "You are a test agent. Respond very briefly.",
});

agent.subscribe((ev) => {
  if (ev.type === "assistant-text-delta") process.stdout.write(ev.text);
  if (ev.type === "run-failed") console.error("\nRUN_FAILED:", ev.error.message);
  if (ev.type === "status-notice") console.error("\n[status]", ev.message);
});

try {
  const r = await agent.run("Reply with the single word: COMPLETE.");
  console.error("\n--- result ---");
  console.error("status:", r.status, "iterations:", r.iterations);
  console.error("outputText:", r.outputText);
  console.error("OK");
} catch (e) {
  console.error("EXCEPTION:", e && e.message);
  process.exit(1);
}