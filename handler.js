/**
 * Reflector — LLM-powered session summarizer hook
 *
 * Reads the full session transcript, strips noise, generates a structured
 * summary via LLM, and saves it to workspace/memory/.
 */
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Resolve OpenClaw internals via the stable extensionAPI
// ---------------------------------------------------------------------------

/** Walk up from the gateway entry point to find the openclaw dist/ directory. */
function resolveOpenclawDist() {
  const entry = process.argv[1] || "";
  let dir = path.dirname(path.resolve(entry));
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg.name === "openclaw") return path.join(dir, "dist");
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let _runEmbeddedPiAgent = null;
let _resolveAgentWorkspaceDir = null;
let _resolveAgentDir = null;

async function loadInternals() {
  if (_runEmbeddedPiAgent) return;

  const dist = resolveOpenclawDist();
  if (!dist) throw new Error("[reflector] Cannot locate openclaw dist/");

  // Use the stable extensionAPI instead of internal hashed modules
  const apiUrl = pathToFileURL(path.join(dist, "extensionAPI.js")).href;
  const api = await import(apiUrl);

  _runEmbeddedPiAgent = api.runEmbeddedPiAgent;
  _resolveAgentWorkspaceDir = api.resolveAgentWorkspaceDir;
  _resolveAgentDir = api.resolveAgentDir;
}

/** Resolve default agent ID from config (inlined — not in extensionAPI exports). */
function resolveDefaultAgentId(cfg) {
  return cfg?.agents?.default ?? "main";
}

/** Resolve hook env config (inlined — not in extensionAPI exports). */
function resolveHookEnv(cfg, hookName) {
  return cfg?.hooks?.internal?.entries?.[hookName]?.env || {};
}

// ---------------------------------------------------------------------------
// Transcript extraction & noise filtering
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^HEARTBEAT_OK$/,
  /^NO_REPLY$/,
  /^Read HEARTBEAT\.md/,
  /^System: \[.*\] Exec finished/,
  /^System: \[.*\] Exec started/,
  /^An async command you ran earlier/,
  /^Approval required \(id/,
];

function isNoise(text) {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/")) return true; // slash commands
  for (const pat of NOISE_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

/**
 * Extract text from a message content field.
 * Handles both string and array-of-blocks formats.
 */
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Parse the session JSONL and return a clean transcript string.
 */
async function buildCleanTranscript(sessionFile, maxChars) {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  const transcript = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Only care about message entries
    if (entry.type !== "message" || !entry.message) continue;

    const msg = entry.message;
    const role = msg.role;

    // Skip tool results and system messages with no useful content
    if (role === "tool") continue;
    if (role === "system") continue;

    const text = extractText(msg.content);
    if (!text) continue;

    // Check for tool_calls in assistant messages — skip pure tool-call messages
    if (role === "assistant" && msg.tool_calls && !text.trim()) continue;

    if (isNoise(text)) continue;

    // For assistant messages, also strip lines that are just tool invocations
    // but keep the human-readable parts
    const cleanedText = text
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        // Skip lines that look like internal tool noise
        if (t.startsWith("🛠️ Exec:")) return false;
        if (t.startsWith("🛠️ Read:")) return false;
        if (t.match(/^System: \[/)) return false;
        return true;
      })
      .join("\n")
      .trim();

    if (!cleanedText) continue;

    const label = role === "user" ? "USER" : role === "assistant" ? "ASSISTANT" : role.toUpperCase();
    transcript.push(`${label}: ${cleanedText}`);
  }

  // Truncate to maxChars from the end (recent context is more important)
  const joined = transcript.join("\n\n");
  if (joined.length > maxChars) {
    return "...(earlier conversation truncated)...\n\n" + joined.slice(-maxChars);
  }
  return joined;
}

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

function splitProviderModel(modelStr) {
  const idx = modelStr.indexOf("/");
  if (idx < 0) return { provider: undefined, model: modelStr };
  return { provider: modelStr.slice(0, idx), model: modelStr.slice(idx + 1) };
}

/**
 * Run a one-shot LLM call via the embedded agent. Returns the text response
 * or null on failure. Tries fallback models if the primary fails.
 */
async function llmCall({ prompt, modelStr, fallbackModels, cfg, label, timeoutMs }) {
  const models = [modelStr, ...(fallbackModels || [])];

  for (const m of models) {
    try {
      const { provider, model } = splitProviderModel(m);
      const agentId = resolveDefaultAgentId(cfg);
      const workspaceDir = _resolveAgentWorkspaceDir(cfg, agentId);
      const agentDir = _resolveAgentDir(cfg, agentId);

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `reflector-${label}-`));
      const tempSession = path.join(tempDir, "session.jsonl");

      const result = await _runEmbeddedPiAgent({
        sessionId: `reflector-${label}-${Date.now()}`,
        sessionKey: `temp:reflector-${label}`,
        sessionFile: tempSession,
        workspaceDir,
        agentDir,
        config: cfg,
        prompt,
        provider,
        model,
        disableTools: true,
        timeoutMs: timeoutMs || 60_000,
        runId: `reflector-${label}-${Date.now()}`,
      });

      // Cleanup temp dir
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      const text = result.payloads?.[0]?.text?.trim();
      if (text) {
        console.log(`[reflector] ${label} succeeded with model ${m}`);
        return text;
      }
      console.warn(`[reflector] ${label} returned empty response from ${m}`);
    } catch (err) {
      console.warn(
        `[reflector] ${label} failed with model ${m}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

const handler = async (event) => {
  if (event.type !== "command" || event.action !== "new") return;

  try {
    await loadInternals();
  } catch (err) {
    console.error("[reflector] Failed to load openclaw internals:", err);
    return;
  }

  const context = event.context || {};
  const cfg = context.cfg;
  if (!cfg) {
    console.warn("[reflector] No config in event context, skipping.");
    return;
  }

  // Resolve hook config from env entries
  const env = resolveHookEnv(cfg, "reflector");

  const summaryModel = env.REFLECTOR_SUMMARY_MODEL || "google/gemini-2.5-flash";
  const slugModel = env.REFLECTOR_SLUG_MODEL || "google/gemini-2.5-flash-lite";
  const fallbackModels = (env.REFLECTOR_FALLBACK_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
  const maxTranscriptChars = parseInt(env.REFLECTOR_MAX_CHARS || "80000", 10);
  const timeoutMs = parseInt(env.REFLECTOR_TIMEOUT_MS || "60000", 10);

  // Find the previous session file
  const sessionEntry = context.previousSessionEntry || context.sessionEntry;
  const sessionFile = sessionEntry?.sessionFile;

  if (!sessionFile) {
    console.log("[reflector] No session file found, skipping.");
    return;
  }

  console.log(`[reflector] Processing session: ${sessionFile}`);

  // Step 1: Build clean transcript
  let transcript;
  try {
    transcript = await buildCleanTranscript(sessionFile, maxTranscriptChars);
  } catch (err) {
    console.error("[reflector] Failed to read session file:", err);
    return;
  }

  if (!transcript || transcript.length < 50) {
    console.log("[reflector] Transcript too short or empty, skipping.");
    return;
  }

  console.log(`[reflector] Clean transcript: ${transcript.length} chars`);

  // Step 2: Generate summary (fire-and-forget style — don't block /new)
  void (async () => {
    try {
      const summaryPrompt = `Summarize this session for future memory recall. Be concise but complete.
Ignore routine heartbeats, empty exchanges, and administrative messages.

**Style Instruction:** Capture the "vibe" and personality of the interaction.
If the user was excited, frustrated, or joking, reflect that context.
Keep the structure, but write the bullet points in a natural, human-readable tone.

Format:
## Summary

**Topics**: [Comma separated list]

**Vibe**: [1-2 sentences capturing the mood/personality of the session]

**Decisions**:
- [Bulleted list]

**Outcomes**:
- [Bulleted list]

**Open Items**:
- [Bulleted list, or "None" if nothing is pending]

Transcript:
${transcript}`;

      const summary = await llmCall({
        prompt: summaryPrompt,
        modelStr: summaryModel,
        fallbackModels,
        cfg,
        label: "summary",
        timeoutMs,
      });

      if (!summary) {
        console.error("[reflector] All models failed for summary generation.");
        return;
      }

      // Step 3: Generate slug
      const slugPrompt = `Based on this summary, generate a concise, lowercase, kebab-case filename slug (3-5 words max).
Examples: "reflector-hook-setup", "dj-library-planning", "discord-bot-debugging"
Output ONLY the slug, nothing else.

Summary:
${summary}`;

      let slug = await llmCall({
        prompt: slugPrompt,
        modelStr: slugModel,
        fallbackModels: [summaryModel, ...fallbackModels],
        cfg,
        label: "slug",
        timeoutMs: 30_000,
      });

      // Clean up slug
      if (slug) {
        slug = slug
          .replace(/```/g, "")
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 40);
      }

      if (!slug || slug.length < 3) {
        const now = new Date();
        slug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "").slice(0, 4);
      }

      // Step 4: Save to memory
      const agentId = resolveDefaultAgentId(cfg);
      const workspaceDir = _resolveAgentWorkspaceDir(cfg, agentId);
      const memoryDir = path.join(workspaceDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });

      const date = new Date().toISOString().split("T")[0];
      const filename = `${date}-reflector-${slug}.md`;
      const savePath = path.join(memoryDir, filename);

      // Avoid overwriting existing files
      let finalPath = savePath;
      try {
        await fs.access(savePath);
        // File exists, add a numeric suffix
        let i = 2;
        while (true) {
          const altPath = path.join(memoryDir, `${date}-reflector-${slug}-${i}.md`);
          try {
            await fs.access(altPath);
            i++;
          } catch {
            finalPath = altPath;
            break;
          }
        }
      } catch {
        // File doesn't exist, use original path
      }

      const content = `---
date: ${date}
session: ${path.basename(sessionFile)}
slug: ${slug}
---

${summary}
`;

      await fs.writeFile(finalPath, content, "utf-8");
      const relPath = finalPath.replace(os.homedir(), "~");
      console.log(`[reflector] ✅ Saved summary to ${relPath}`);
    } catch (err) {
      console.error("[reflector] Error during summary generation:", err);
    }
  })();
};

export default handler;
