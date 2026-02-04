# openclaw-hook-reflector

LLM-powered session summarizer hook for OpenClaw. Replaces the default session-memory hook with structured summaries.

## What it does

1. Listens for the `/new` command (session reset)
2. Reads the full previous session transcript
3. Filters out noise (heartbeats, NO_REPLY, tool calls, system messages, slash commands)
4. Summarizes the transcript using a configurable LLM — structured output with Topics, Vibe, Decisions, Outcomes, and Open Items
5. Generates a kebab-case filename slug via a cheap/fast model
6. Saves the summary to `<workspace>/memory/` as a dated Markdown file

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw)
- Node.js
- At least one LLM provider configured in OpenClaw

## Installation

1. Clone into `~/.openclaw/hooks/`
2. Disable the built-in `session-memory` hook
3. Enable `reflector` in your OpenClaw config:

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

## Configuration

| Variable | Default | Description |
|---|---|---|
| REFLECTOR_SUMMARY_MODEL | google/gemini-2.5-flash | Model for summary generation |
| REFLECTOR_SLUG_MODEL | google/gemini-2.5-flash-lite | Model for filename slug generation |
| REFLECTOR_FALLBACK_MODELS | (empty) | Comma-separated fallback models |
| REFLECTOR_MAX_CHARS | 80000 | Max transcript characters sent to LLM |
| REFLECTOR_TIMEOUT_MS | 60000 | Timeout per LLM call in ms |

## Output format

Example saved file:

```md
---
date: 2026-02-04
session: 2026-02-03.jsonl
slug: reflector-hook-setup
---

## Summary

**Topics**: OpenClaw hooks, Session summarization, Configuration

**Vibe**: Focused and practical; the user wants low-friction setup and predictable output.

**Decisions**:
- Replace `session-memory` with `reflector`
- Use `google/gemini-2.5-flash` for summary generation

**Outcomes**:
- Hook enabled and configured
- Session summaries saved under `memory/` for later recall

**Open Items**:
- Persist transcripts for retry on failed LLM calls
```

## Background

Based on [PR #1650](https://github.com/openclaw/openclaw/pull/1650) which proposed built-in session summarization. This hook takes a different approach by running as an external hook with configurable models and structured output.

## Future improvements

- Persist transcript data to a temp folder for retry when both primary and fallback LLM calls fail (currently the summary is lost if all models fail)

## License

MIT
