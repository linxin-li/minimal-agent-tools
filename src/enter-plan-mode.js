#!/usr/bin/env bun
/**
 * EnterPlanMode — toggle the agent into a read-only "design first" mode.
 *
 * Plan mode is just a state machine: a flag on disk that says "you should be
 * exploring + writing a plan, not editing files." It's the tool side of the
 * pattern. Enforcement (refusing Edit/Write while active) is the caller's job.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIG = {
  STATE_FILE: path.join(os.tmpdir(), 'agent-plan-mode.json'),
  PLAN_FILE_DEFAULT: 'PLAN.md',
}

function loadState() {
  if (!fs.existsSync(CONFIG.STATE_FILE)) {
    return {
      active: false,
      planFile: null,
      enteredAt: null,
    }
  }

  try {
    const content = fs.readFileSync(CONFIG.STATE_FILE, 'utf-8')
    return JSON.parse(content)
  } catch {
    return { active: false, planFile: null, enteredAt: null }
  }
}

function saveState(state) {
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Activate plan mode.
 * @param {{ planFile?: string }} [options]
 */
function enterPlanMode(options = {}) {
  const { planFile = CONFIG.PLAN_FILE_DEFAULT } = options

  const state = loadState()

  if (state.active) {
    return {
      success: false,
      error: 'Already in plan mode',
      currentPlanFile: state.planFile,
      enteredAt: state.enteredAt,
    }
  }

  const newState = {
    active: true,
    planFile: path.resolve(process.cwd(), planFile),
    enteredAt: new Date().toISOString(),
    cwd: process.cwd(),
  }

  saveState(newState)

  return {
    success: true,
    message: 'Entered plan mode',
    planFile: newState.planFile,
    enteredAt: newState.enteredAt,
    instructions: `
Plan mode is active.

In this mode the agent should:
  - Use Read/Glob/Grep to explore the codebase.
  - NOT call Edit/Write on existing files (caller enforces).
  - Write the implementation plan to: ${newState.planFile}
  - Call ExitPlanMode to request approval when ready.

Suggested plan-file structure:
  1. Goal
  2. Files to be modified
  3. Step-by-step plan
  4. Risks / open questions
`,
  }
}

function isPlanMode() {
  const state = loadState()
  return {
    active: state.active,
    planFile: state.planFile,
    enteredAt: state.enteredAt,
    cwd: state.cwd,
  }
}

function getPlanContent() {
  const state = loadState()

  if (!state.active) {
    return { found: false, error: 'Not in plan mode' }
  }

  if (!fs.existsSync(state.planFile)) {
    return {
      found: false,
      error: `Plan file not found: ${state.planFile}`,
      planFile: state.planFile,
    }
  }

  const content = fs.readFileSync(state.planFile, 'utf-8')

  return {
    found: true,
    planFile: state.planFile,
    content,
    lines: content.split('\n').length,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    status: args.includes('--status') || args.includes('-s'),
    plan: args.includes('--plan') || args.includes('-p'),
  }

  let planFile = CONFIG.PLAN_FILE_DEFAULT
  const fileIdx = args.indexOf('--file')
  if (fileIdx !== -1) planFile = args[fileIdx + 1]

  if (flags.help) {
    console.log(`
EnterPlanMode — toggle plan mode on

Usage:
  bun enter-plan-mode.js [options]

Options:
  --file <path>     Plan file path (default: ${CONFIG.PLAN_FILE_DEFAULT})
  --status, -s      Show current plan-mode state
  --plan, -p        Show current plan content
  --json            Output JSON
  --help            Show this help

Examples:
  bun enter-plan-mode.js
  bun enter-plan-mode.js --file my-plan.md
  bun enter-plan-mode.js --status

State file: ${CONFIG.STATE_FILE}
`)
    process.exit(0)
  }

  try {
    let result

    if (flags.status) {
      result = isPlanMode()

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (result.active) {
          console.log('Plan mode: ACTIVE')
          console.log(`Plan file: ${result.planFile}`)
          console.log(`Entered at: ${result.enteredAt}`)
        } else {
          console.log('Plan mode: INACTIVE')
        }
      }
    } else if (flags.plan) {
      result = getPlanContent()

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.found) {
          console.error('Error:', result.error)
          process.exit(1)
        }
        console.log(`Plan file: ${result.planFile}`)
        console.log(`Lines: ${result.lines}`)
        console.log('---')
        console.log(result.content)
      }
    } else {
      result = enterPlanMode({ planFile })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.success) {
          console.error('Error:', result.error)
          if (result.currentPlanFile) {
            console.log(`Current plan file: ${result.currentPlanFile}`)
          }
          process.exit(1)
        }
        console.log(result.message)
        console.log(`Plan file: ${result.planFile}`)
        console.log(result.instructions)
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { enterPlanMode, isPlanMode, getPlanContent, loadState, saveState, CONFIG }

if (import.meta.main) {
  main()
}
