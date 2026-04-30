#!/usr/bin/env bun
/**
 * ExitPlanMode — leave plan mode and surface the plan for user approval.
 */

import fs from 'node:fs'
import { loadState, saveState } from './enter-plan-mode.js'

/**
 * Exit plan mode.
 *
 * @param {Object} [options]
 * @param {Array<{ tool: string, prompt: string }>} [options.allowedPrompts]
 *        Permission requests the agent wants approved alongside the plan.
 * @param {boolean} [options.launchSwarm] - Whether to fan out work after approval.
 * @param {number} [options.teammateCount]
 */
function exitPlanMode(options = {}) {
  const { allowedPrompts = [], launchSwarm = false, teammateCount } = options

  const state = loadState()

  if (!state.active) {
    return {
      success: false,
      error: 'Not in plan mode',
    }
  }

  let planContent = null
  let planExists = false

  if (state.planFile && fs.existsSync(state.planFile)) {
    planContent = fs.readFileSync(state.planFile, 'utf-8')
    planExists = true
  }

  const enteredAt = new Date(state.enteredAt)
  const exitedAt = new Date()
  const durationMs = exitedAt.getTime() - enteredAt.getTime()
  const durationMin = Math.round(durationMs / 60000)

  const result = {
    success: true,
    message: 'Exited plan mode - awaiting user approval',
    planFile: state.planFile,
    planExists,
    planContent: planExists ? planContent : null,
    planSummary: planExists ? summarizePlan(planContent) : null,
    duration: {
      ms: durationMs,
      minutes: durationMin,
    },
    enteredAt: state.enteredAt,
    exitedAt: exitedAt.toISOString(),
    requestedPermissions: allowedPrompts,
    launchSwarm,
    teammateCount,
  }

  // Reset to inactive but remember the plan as pending approval.
  saveState({
    active: false,
    planFile: null,
    enteredAt: null,
    lastPlan: {
      file: state.planFile,
      exitedAt: exitedAt.toISOString(),
      approved: false,
    },
  })

  return result
}

/**
 * Lightweight markdown plan summary.
 */
function summarizePlan(content) {
  const lines = content.split('\n')
  const headers = lines.filter((l) => l.startsWith('#'))
  const todoItems = lines.filter((l) => l.match(/^[\s]*[-*]\s*\[[ x]\]/i))
  const codeBlocks = (content.match(/```/g) || []).length / 2

  return {
    totalLines: lines.length,
    headers: headers.length,
    todoItems: todoItems.length,
    codeBlocks: Math.floor(codeBlocks),
    preview: content.substring(0, 500) + (content.length > 500 ? '...' : ''),
  }
}

function getPendingPlan() {
  const state = loadState()

  if (state.lastPlan && !state.lastPlan.approved) {
    const planFile = state.lastPlan.file
    if (planFile && fs.existsSync(planFile)) {
      return {
        pending: true,
        planFile,
        content: fs.readFileSync(planFile, 'utf-8'),
        exitedAt: state.lastPlan.exitedAt,
      }
    }
  }

  return { pending: false }
}

function approvePlan() {
  const state = loadState()

  if (!state.lastPlan) {
    return { success: false, error: 'No plan to approve' }
  }

  state.lastPlan.approved = true
  state.lastPlan.approvedAt = new Date().toISOString()
  saveState(state)

  return {
    success: true,
    message: 'Plan approved',
    planFile: state.lastPlan.file,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    pending: args.includes('--pending'),
    approve: args.includes('--approve'),
    launchSwarm: args.includes('--launch-swarm'),
  }

  let teammateCount
  const countIdx = args.indexOf('--teammates')
  if (countIdx !== -1) teammateCount = parseInt(args[countIdx + 1], 10)

  const allowedPrompts = []
  const promptIdx = args.indexOf('--allow')
  if (promptIdx !== -1) {
    let idx = promptIdx
    while (idx < args.length - 1) {
      if (args[idx] === '--allow' && args[idx + 1]) {
        allowedPrompts.push({ tool: 'Bash', prompt: args[idx + 1] })
      }
      idx++
    }
  }

  if (flags.help) {
    console.log(`
ExitPlanMode — leave plan mode and surface the plan for approval

Usage:
  bun exit-plan-mode.js [options]

Options:
  --pending         Show the most recent pending plan
  --approve         Approve the most recent pending plan
  --allow <prompt>  Add a permission to request (repeatable)
  --launch-swarm    Hint that the plan will fan out into multiple workers
  --teammates <n>   Swarm size hint
  --json            Output JSON
  --help            Show this help

Examples:
  bun exit-plan-mode.js
  bun exit-plan-mode.js --pending
  bun exit-plan-mode.js --approve
  bun exit-plan-mode.js --allow "run tests" --allow "build project"
`)
    process.exit(0)
  }

  try {
    let result

    if (flags.pending) {
      result = getPendingPlan()

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.pending) {
          console.log('No pending plan')
        } else {
          console.log('Pending plan:')
          console.log(`File: ${result.planFile}`)
          console.log(`Exited at: ${result.exitedAt}`)
          console.log('---')
          console.log(result.content)
        }
      }
    } else if (flags.approve) {
      result = approvePlan()

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.success) {
          console.error('Error:', result.error)
          process.exit(1)
        }
        console.log(result.message)
        console.log(`Plan file: ${result.planFile}`)
      }
    } else {
      result = exitPlanMode({
        allowedPrompts,
        launchSwarm: flags.launchSwarm,
        teammateCount,
      })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.success) {
          console.error('Error:', result.error)
          process.exit(1)
        }
        console.log(result.message)
        console.log(`Plan file: ${result.planFile}`)
        console.log(`Duration: ${result.duration.minutes} minutes`)

        if (result.planExists) {
          console.log('\n--- Plan Summary ---')
          console.log(`Lines: ${result.planSummary.totalLines}`)
          console.log(`Headers: ${result.planSummary.headers}`)
          console.log(`Todo items: ${result.planSummary.todoItems}`)
          console.log(`Code blocks: ${result.planSummary.codeBlocks}`)
          console.log('\n--- Preview ---')
          console.log(result.planSummary.preview)
        } else {
          console.log('\nWarning: Plan file not found')
        }

        if (result.requestedPermissions.length > 0) {
          console.log('\n--- Requested Permissions ---')
          for (const perm of result.requestedPermissions) {
            console.log(`  [${perm.tool}] ${perm.prompt}`)
          }
        }
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { exitPlanMode, getPendingPlan, approvePlan, summarizePlan }

if (import.meta.main) {
  main()
}
