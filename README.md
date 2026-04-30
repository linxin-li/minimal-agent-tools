# minimal-agent-tools

> **The 18 tools every coding agent needs — written small, written once, ready to fork.**
>
> Stop reimplementing `Read`, `Bash`, `Edit`, `Grep`, plan mode, and `WebSearch`. Take these, ship your agent in days, not weeks.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-black.svg)](https://bun.sh)

---

## The problem

You want to build a coding agent. Maybe a Claude Code-style internal tool. Maybe a Cursor-style IDE assistant. Maybe an autonomous bot that ships PRs.

The first week of every such project is the same:

- *"How should `Read` format file output so the model can edit it correctly?"*
- *"Should `Bash` be sandboxed? How?"*
- *"Why does my `Edit` tool keep corrupting unrelated code?"*
- *"How do I implement plan mode without it being magic?"*
- *"How do I do web search without writing a scraper?"*
- *"How do I compact long conversations without losing context?"*

Every team rediscovers the same answers. The shapes converge — they're constrained by what an LLM can call reliably, not by what's clever.

**This repo is those answers, in 18 small ESM files.**

---

## What you get

| | |
|---|---|
| **18 tools** | Every primitive a coding agent needs (see [Tool list](#tool-list)) |
| **~10 KB each** | Read one in 5 minutes. Read all 18 in an afternoon. |
| **Zero framework** | No `Agent` class, no orchestrator, no abstractions to learn |
| **Standalone files** | Each tool is one ESM file. Copy-paste subset is fine. |
| **MIT licensed** | Fork, modify, ship — no attribution required |
| **CLI + library** | Every tool ships as both `import` and `bun src/X.js` |
| **Production patterns** | The non-obvious decisions (sandbox-exec, exact-string Edit, line-numbered Read) are baked in |

---

## Quick start

```bash
npm install minimal-agent-tools
# or: bun add minimal-agent-tools
```

```js
import { readFile } from 'minimal-agent-tools/read'
import { bashExecute } from 'minimal-agent-tools/bash'
import { editFile } from 'minimal-agent-tools/edit'

// Read a file with line numbers (LLM-friendly format)
const file = readFile('/path/to/code.ts', { offset: 1, limit: 50 })
console.log(file.content)
// Output:
//      1   import { foo } from './bar'
//      2   const x = 42
//      3   ...

// Run a shell command with timeout + output cap
const result = await bashExecute('npm test', { timeout: 60_000 })

// Edit a file — fails loudly if old_string isn't unique
editFile('/path/to/code.ts', 'const x = 42', 'const x = 100')
```

Want a complete agent? [`examples/minimal-agent.js`](examples/minimal-agent.js) is **~50 lines** that wires these tools to Claude:

```bash
bun add @anthropic-ai/sdk
ANTHROPIC_API_KEY=sk-... bun examples/minimal-agent.js "find all TODOs in src/"
```

---

## When teams use this

### 🟢 If you're building an internal coding agent for your team
You want a custom version of Claude Code / Cursor that knows your stack, your conventions, your private repos. **Drop these in as the tool layer.** Wire them to your LLM of choice. Skip the first 1-2 weeks of the project.

### 🟢 If you're writing an MCP server with file/shell tools
The MCP spec defines the *protocol*. You still need to implement what `Read`, `Edit`, `Bash` actually do. **Use these as your `execute` handlers.** The shape (params, returns, error handling) is already proven against real LLMs.

### 🟢 If you're porting a coding-agent flow to a different LLM
You like Claude Code's UX but want to run on local Llama, GPT-5, or your own fine-tune. **Tools stay the same; only the LLM caller changes.** These give you the toolset, you bring your model.

### 🟢 If you're studying how production agents work
Reading bundled `cli.js` is painful. Reading 18 well-named ESM files is not. **Use this as a reference implementation** to understand the design space before building your own.

### 🟡 If you want a turnkey agent product
This isn't that. Use Claude Code, Cursor, or Aider directly. Come back when you need to build something custom.

---

## Why these implementations work (the effectiveness question)

Honest answer: this isn't a benchmark winner — there's no "X% faster than LangChain" claim, because the bottleneck in agent quality is the LLM, not the tools.

**What you get instead is "correct by design".** Each tool encodes a decision that production coding agents converge on after weeks of debugging. You don't have to rediscover them.

A few examples of what's baked in:

- **`Edit` uses exact-string match with a uniqueness check** → models can't silently corrupt unrelated code by hallucinating a hunk header.
- **`Bash` writes its background output to a file, not memory** → long-running commands don't blow up context.
- **`Read` uses tab-separated line numbers (`     12\tconst x = 1`)** → models recover line numbers reliably for the next `Edit` call.
- **`Compact` inserts a boundary marker** → "summarize and continue" composes; you can compact 10 times in one session without state corruption.
- **`Plan mode` is a state file, not a hook** → enforcement stays in the caller, so you can plug it into any agent loop.
- **`WebSearch` wraps Anthropic's native tool** → you don't fight Google's anti-bot, ranking, or rate limits.

Read the [Insights](#insights--the-bits-worth-stealing) section below for the long-form versions.

---

## Tool list

| Category   | Tool             | File                          | What it does |
|------------|------------------|-------------------------------|--------------|
| **File ops**   | Read             | [`src/read.js`](src/read.js)               | File reader, offset/limit pagination, `cat -n` line numbers, image / PDF / Jupyter handling |
|            | Write            | [`src/write.js`](src/write.js)             | File writer with auto-`mkdir -p` and size cap |
|            | Edit             | [`src/edit.js`](src/edit.js)               | Exact-string replace, fails loudly on non-unique matches |
|            | Glob             | [`src/glob.js`](src/glob.js)               | Pattern matcher, results sorted by mtime (newest first) |
|            | Grep             | [`src/grep.js`](src/grep.js)               | Regex search, three output modes, type / glob filters, binary file detection |
| **Editing**    | NotebookEdit     | [`src/notebook-edit.js`](src/notebook-edit.js) | Replace / insert / delete cells in `.ipynb` files |
| **Shell**      | Bash             | [`src/bash.js`](src/bash.js)               | Foreground + detached commands, output cap, SIGTERM→SIGKILL escalation |
|            | KillShell        | [`src/kill-shell.js`](src/kill-shell.js)   | Terminate background process by id or PID |
| **Tasks**      | Task             | [`src/task.js`](src/task.js)               | Sub-agent task lifecycle skeleton (you plug in the runner) |
|            | TaskOutput       | [`src/task-output.js`](src/task-output.js) | Poll for output of a task or background shell |
|            | TodoWrite        | [`src/todo-write.js`](src/todo-write.js)   | Persistent todo list (JSON on disk) |
| **Plan mode** | EnterPlanMode    | [`src/enter-plan-mode.js`](src/enter-plan-mode.js) | Toggle "design first, edit later" state |
|            | ExitPlanMode     | [`src/exit-plan-mode.js`](src/exit-plan-mode.js)  | Surface the plan for approval, with markdown summary |
| **Interaction**| AskUserQuestion  | [`src/ask-user-question.js`](src/ask-user-question.js) | Multi-choice prompts (1–4 questions × 2–4 options + "Other") |
|            | Skill            | [`src/skill.js`](src/skill.js)             | Markdown-frontmatter skill loader (built-in + user-defined) |
| **Network**    | WebFetch         | [`src/web-fetch.js`](src/web-fetch.js)     | URL → Markdown, optional Claude summarization, 15-min cache |
|            | WebSearch        | [`src/web-search.js`](src/web-search.js)   | Wraps Anthropic's native `web_search` tool — no scraper |
| **Slash cmd**  | Compact          | [`src/compact.js`](src/compact.js)         | Conversation summarization with boundary marker |

**Total**: ~6,500 lines including comments. ~177 KB on disk.

---

## How to use it (three patterns)

### Pattern 1 — Drop-in primitives (most common)

Install via npm/bun, import what you need, wire into your existing agent loop:

```js
import * as tools from 'minimal-agent-tools'

const TOOL_HANDLERS = {
  read:  (args) => tools.readFile(args.file_path, args),
  bash:  (args) => tools.bashExecute(args.command, args),
  edit:  (args) => tools.editFile(args.file_path, args.old, args.new, args),
  grep:  (args) => tools.grep(args.pattern, args),
}

// Your existing agent loop:
async function runTool(name, args) {
  return await TOOL_HANDLERS[name](args)
}
```

### Pattern 2 — Fork & modify

Clone the repo, customize for your stack:

```bash
gh repo fork linxin-li/minimal-agent-tools
# Now edit src/bash.js to add your sandbox profile
# Edit src/web-fetch.js to swap in OpenAI instead of Claude
# Ship as your-org/your-agent-tools
```

The MIT license means no attribution required, no royalties, nothing to clear with legal.

### Pattern 3 — Reference reading

You're not adopting the code, you're learning the patterns. Read these in order for a 1-hour crash course in how production coding agents work:

1. **`src/read.js`** — the LLM-friendly file format
2. **`src/edit.js`** — why exact-string match beats diff
3. **`src/bash.js`** — sandboxing + output management
4. **`src/enter-plan-mode.js`** + **`src/exit-plan-mode.js`** — plan mode as a state machine
5. **`src/compact.js`** — the boundary-marker pattern

Then you'll know what decisions to make for your own version, even if you don't use a single line of this code.

---

## Insights — the bits worth stealing

Long-form versions of the design decisions baked into these tools. Each one cost some real-world team a debugging weekend before they figured it out.

### 1. Bash should be sandboxed by default on macOS

Coding agents that run shell commands need to gate file access — the LLM **will** eventually try to `rm` something it shouldn't. macOS ships with `sandbox-exec`: a 5-line policy file plus a process wrapper gives you isolation without a container. Linux equivalents are `landlock` and `bwrap`.

→ See [`src/bash.js`](src/bash.js).

### 2. Edit on exact string match, not diff

Diff-based edits hallucinate. Hunk headers drift, line numbers slide by one, the model "fixes" a phantom bug at line 47 instead of the real one at line 48. Exact-string replace with a **uniqueness check** fails loudly when the model didn't see enough context, instead of silently corrupting the wrong region.

→ See [`countOccurrences` + the `> 1 && !replaceAll` guard](src/edit.js).

### 3. Read tool output format matters more than you'd think

The tab between line number and content (`     12\tconst x = 1`) is load-bearing. LLMs parse that tab as a structural separator and produce more accurate `Edit` calls because they can recover line numbers cleanly. Long-line truncation at 2,000 chars protects against minified blobs eating the context window.

→ See [`src/read.js`](src/read.js).

### 4. Plan mode is a state machine, not magic

"Plan mode" is a flag on disk + a convention: while active, the agent uses `Read` / `Glob` / `Grep` to explore and writes a plan file, but doesn't call `Edit` / `Write`. **Enforcement is the caller's job.** The `enter` / `exit` pair plus an approval state handles the entire lifecycle in ~200 lines.

→ See [`src/enter-plan-mode.js`](src/enter-plan-mode.js) + [`src/exit-plan-mode.js`](src/exit-plan-mode.js).

### 5. WebSearch wants the provider's native tool, not your scraper

Anthropic's `web_search_20250305` tool runs server-side: indexing, ranking, snippet extraction. You won't beat it in a weekend. Wrap it; don't rebuild it.

→ See [`src/web-search.js`](src/web-search.js).

### 6. Compact needs a boundary marker, not just a summary

The non-obvious part of "summarize and continue" is the `compact_boundary` marker message. Drop it between the summary and the kept tail; on every subsequent turn, filter to messages **after** the marker before sending to the LLM. That single line of state is what makes the pattern composable across long-running agents — without it, you have to track turn counts everywhere.

→ See [`getMessagesAfterCompact`](src/compact.js).

---

## What this is **not**

- ❌ **Not a framework.** No `Agent` class, no orchestration layer, no MCP server wrapping.
- ❌ **Not a Claude Code clone.** Tool shapes loosely follow conventions used by major coding agents because the LLM-callable interface space is small. Implementations are independent.
- ❌ **Not production-grade out of the box.** Treat these as readable references — add logging, permissioning, and error handling before deploying to real users.
- ❌ **Not a benchmark winner.** Agent quality bottleneck is the LLM, not the tools. We optimize for "correct by design", not "fastest in microbenchmark".

---

## FAQ

**Q: Does this work with OpenAI / Gemini / local models?**
A: 16 of 18 tools work with any LLM (they don't care who's calling them). Only `web-fetch.js` (optional summarization) and `web-search.js` use Anthropic's API directly. Swap them or skip them.

**Q: Why JavaScript? I work in Python.**
A: Two reasons: (1) Bun makes single-file ESM scripts trivial to run as both module and CLI, (2) most coding-agent UIs are Electron / web-based, where JS is already there. A Python port is welcome — open a PR.

**Q: Where are the tests?**
A: Each tool has a working example in its `--help` block and runs end-to-end as a CLI. Formal unit tests are TODO. Treat the code as readable; verify behavior in your own integration tests.

**Q: Can I use this in a closed-source product?**
A: Yes. MIT license. No attribution required (though we'd love a star).

**Q: Why no TypeScript types?**
A: Each function has JSDoc. We chose readability over `.d.ts` ceremony for v0.1. Types are welcome via PR.

---

## Built by Moclaw

[Moclaw](https://moclaw.ai) is building AI agents for developers. We built this set while building our own product, and shared it here because the patterns belong to the community.

If you ship something with these tools, [we'd love to hear about it](https://moclaw.ai). We're hiring agent engineers — see [moclaw.ai](https://moclaw.ai).

## License

[MIT](LICENSE) — fork freely.

---

⭐ **If this saved you a week**, drop a star. It helps others find it.
