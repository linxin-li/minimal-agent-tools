# minimal-agent-tools

> **18 minimal, dependency-light implementations of the tools every modern coding agent ships.** ~10 KB each, ESM, zero magic. Read them, fork them, ship them.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why this exists

Every team building a coding agent ends up reimplementing the same 18 tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `Task`, `TodoWrite`, plan mode, `AskUserQuestion`, `WebFetch`, `WebSearch`, etc. The shapes converge — they're constrained by what an LLM can call reliably, not by what's clever.

After implementing these tools more than once, we distilled the patterns into 18 small ESM modules you can read in one sitting. **They are starting points, not products.**

## Tool list

| Category   | Tool             | File                          | What it does |
|------------|------------------|-------------------------------|--------------|
| File ops   | Read             | [`src/read.js`](src/read.js)               | File reader, offset/limit pagination, `cat -n` line numbers, image/PDF/notebook handling |
|            | Write            | [`src/write.js`](src/write.js)             | File writer with auto-`mkdir -p` |
|            | Edit             | [`src/edit.js`](src/edit.js)               | Exact-string replace, fails loudly on non-unique matches |
|            | Glob             | [`src/glob.js`](src/glob.js)               | Pattern matcher, results sorted by mtime |
|            | Grep             | [`src/grep.js`](src/grep.js)               | Regex search, three output modes, type/glob filters |
| Editing    | NotebookEdit     | [`src/notebook-edit.js`](src/notebook-edit.js) | Replace/insert/delete cells in `.ipynb` files |
| Shell      | Bash             | [`src/bash.js`](src/bash.js)               | Foreground + detached commands, output cap, timeout escalation |
|            | KillShell        | [`src/kill-shell.js`](src/kill-shell.js)   | SIGTERM → SIGKILL escalation, by id or PID |
| Tasks      | Task             | [`src/task.js`](src/task.js)               | Sub-agent task lifecycle skeleton |
|            | TaskOutput       | [`src/task-output.js`](src/task-output.js) | Poll for output of a task or background shell |
|            | TodoWrite        | [`src/todo-write.js`](src/todo-write.js)   | Persistent todo list (JSON on disk) |
| Plan mode  | EnterPlanMode    | [`src/enter-plan-mode.js`](src/enter-plan-mode.js) | Toggle "design first, edit later" state |
|            | ExitPlanMode     | [`src/exit-plan-mode.js`](src/exit-plan-mode.js)  | Surface the plan for approval |
| Interaction| AskUserQuestion  | [`src/ask-user-question.js`](src/ask-user-question.js) | Multi-choice prompts (1-4 questions × 2-4 options) |
|            | Skill            | [`src/skill.js`](src/skill.js)             | Markdown-frontmatter skill loader |
| Network    | WebFetch         | [`src/web-fetch.js`](src/web-fetch.js)     | URL → Markdown, optional LLM summarization |
|            | WebSearch        | [`src/web-search.js`](src/web-search.js)   | Wraps Anthropic's native `web_search` tool |
| Slash cmd  | Compact          | [`src/compact.js`](src/compact.js)         | Conversation summarization with boundary marker |

## Install

```bash
npm install minimal-agent-tools
# or
bun add minimal-agent-tools
```

Or just copy the files you need. Each one is a single self-contained ESM module.

## Usage

```js
import { readFile } from 'minimal-agent-tools/read'
import { bashExecute } from 'minimal-agent-tools/bash'
import { editFile } from 'minimal-agent-tools/edit'

const file = readFile('/abs/path/to/code.ts', { offset: 1, limit: 50 })
console.log(file.content)

const result = await bashExecute('npm test', { timeout: 60_000 })
console.log(result.stdout)

editFile('/abs/path/to/code.ts', 'const x = 1', 'const x = 2')
```

CLI mode (every tool ships as a runnable script):

```bash
bun src/read.js /abs/path/to/file.js --offset 100 --limit 50
bun src/grep.js "TODO" --type js --mode content -C 2
bun src/bash.js "npm install" --background
```

## Insights — the bits worth stealing

A handful of non-obvious decisions show up across production coding agents. Each section below is the short version.

### 1. Bash should be sandboxed by default on macOS

Production agents that run shell commands need to gate file access — the LLM will eventually try to `rm` something it shouldn't. macOS ships with `sandbox-exec`: a 5-line policy file plus a process wrapper gives you isolation without a container. Linux equivalents are `landlock` and `bwrap`.

→ See [`src/bash.js`](src/bash.js).

### 2. Edit on exact string match, not diff

Diff-based edits hallucinate. Hunk headers drift, line numbers slide by one, the model fixes a phantom bug at line 47 instead of the real one at line 48. Exact-string replace with a **uniqueness check** fails loudly when the model didn't see enough context, instead of silently corrupting the wrong region.

→ See [`countOccurrences` and the `> 1 && !replaceAll` guard](src/edit.js).

### 3. Read tool output format matters more than you'd think

The tab between line number and content (`     12\tconst x = 1`) is load-bearing. LLMs parse that tab as a structural separator and produce more accurate `Edit` calls because they can recover line numbers cleanly. Long-line truncation at 2,000 chars protects against minified blobs eating the context window.

→ See [`src/read.js`](src/read.js).

### 4. Plan mode is a state machine, not magic

"Plan mode" is a flag on disk + a convention: while active, the agent uses `Read`/`Glob`/`Grep` to explore and writes a plan file, but doesn't call `Edit`/`Write`. Enforcement is the caller's job. The `enter` / `exit` pair plus an approval state handles the entire lifecycle in ~200 lines.

→ See [`src/enter-plan-mode.js`](src/enter-plan-mode.js) + [`src/exit-plan-mode.js`](src/exit-plan-mode.js).

### 5. WebSearch wants the provider's native tool, not your scraper

Anthropic's `web_search_20250305` tool runs server-side: indexing, ranking, snippet extraction. You won't beat it in a weekend. Wrap it; don't rebuild it.

→ See [`src/web-search.js`](src/web-search.js).

### 6. Compact needs a boundary marker, not just a summary

The non-obvious part of "summarize and continue" is the `compact_boundary` marker message. Drop it between the summary and the kept tail; on every subsequent turn, filter to messages **after** the marker before sending to the LLM. That single line of state is what makes the pattern composable across long-running agents.

→ See [`getMessagesAfterCompact`](src/compact.js).

## Example: 50-line agent loop

[`examples/minimal-agent.js`](examples/minimal-agent.js) is a complete agent loop using `read`, `glob`, and `bash` from this package plus the Anthropic SDK:

```bash
bun add @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-... bun examples/minimal-agent.js "list the TypeScript files in src"
```

It demonstrates the canonical pattern: model-calls-tool → run tool → feed result back → repeat until `stop_reason !== 'tool_use'`. ~50 lines of glue, three tools, and you have a working coding agent.

## What this is **not**

- **Not a framework.** No `Agent` class, no orchestration layer, no MCP wrapper.
- **Not a clone.** Tool shapes loosely follow conventions used by major coding agents because the LLM-callable interface space is small. Implementations are independent.
- **Not production-grade.** Treat these as readable references; add logging, permissioning, and error handling before deploying.

## License

[MIT](LICENSE)

---

Contributed by the Moclaw team — [https://moclaw.ai](https://moclaw.ai)
