---
name: reflector
description: "Generates high-quality LLM session summaries with decisions, outcomes, and open items"
metadata:
  {
    "openclaw":
      {
        "emoji": "🪞",
        "events": ["command:new"],
        "requires": { "bins": ["node"], "config": ["workspace.dir"] },
      },
  }
---

# Reflector Hook

Replaces the bundled `session-memory` hook with a proper LLM-powered summarizer.

## What It Does

1. **Listens** for the `/new` command
2. **Reads** the full previous session transcript
3. **Filters** out noise (heartbeats, NO_REPLY, tool calls, system messages)
4. **Summarizes** using a configurable LLM model (structured: Topics, Vibe, Decisions, Outcomes, Open Items)
5. **Generates** a kebab-case slug via a cheap model
6. **Saves** to `memory/YYYY-MM-DD-slug.md`

## Configuration

Configure via `env` in the hook entry (hook entries only support `enabled` + `env`):

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false },
        "reflector": {
          "enabled": true,
          "env": {
            "REFLECTOR_SUMMARY_MODEL": "google/gemini-2.5-flash",
            "REFLECTOR_SLUG_MODEL": "google/gemini-2.5-flash-lite",
            "REFLECTOR_FALLBACK_MODELS": "anthropic/claude-sonnet-4",
            "REFLECTOR_MAX_CHARS": "80000",
            "REFLECTOR_TIMEOUT_MS": "60000"
          }
        }
      }
    }
  }
}
```

| Env Var | Default | Description |
|---|---|---|
| `REFLECTOR_SUMMARY_MODEL` | `google/gemini-2.5-flash` | Model for summary generation |
| `REFLECTOR_SLUG_MODEL` | `google/gemini-2.5-flash-lite` | Cheap model for slug generation |
| `REFLECTOR_FALLBACK_MODELS` | *(empty)* | Comma-separated fallback models |
| `REFLECTOR_MAX_CHARS` | `80000` | Max transcript chars sent to LLM |
| `REFLECTOR_TIMEOUT_MS` | `60000` | Timeout per LLM call (ms) |

## Requirements

- Node.js
- `workspace.dir` configured (automatic during onboarding)
- At least one LLM provider configured

## Disable

```bash
openclaw hooks disable reflector
```
