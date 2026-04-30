#!/usr/bin/env bun
/**
 * TaskOutput — fetch the (current or final) output of a background task or shell.
 *
 * Polls the underlying registry (task.js or bash.js) at POLL_INTERVAL until either
 * the task completes or `timeout` elapses.
 */

import fs from 'node:fs'
import { getTaskStatus } from './task.js'
import { getBackgroundStatus } from './bash.js'

const CONFIG = {
  DEFAULT_TIMEOUT: 30000, // 30 s
  MAX_TIMEOUT: 600000, // 10 min
  POLL_INTERVAL: 500,
}

/**
 * Get the output of a task or background shell.
 *
 * @param {string} taskId - Either a `task-...` id (from task.js) or a `bg-...` id (from bash.js).
 * @param {Object} [options]
 * @param {boolean} [options.block=true] - Wait for completion.
 * @param {number} [options.timeout]
 */
async function getTaskOutput(taskId, options = {}) {
  const { block = true, timeout = CONFIG.DEFAULT_TIMEOUT } = options

  if (!taskId) {
    throw new Error('task_id is required')
  }

  const actualTimeout = Math.min(timeout, CONFIG.MAX_TIMEOUT)

  if (taskId.startsWith('task-')) {
    return getTaskRegistryOutput(taskId, { block, timeout: actualTimeout })
  } else if (taskId.startsWith('bg-')) {
    return getBashBackgroundOutput(taskId, { block, timeout: actualTimeout })
  } else {
    let result = await getTaskRegistryOutput(taskId, { block, timeout: actualTimeout })
    if (!result.found) {
      result = await getBashBackgroundOutput(taskId, { block, timeout: actualTimeout })
    }
    return result
  }
}

async function getTaskRegistryOutput(taskId, options) {
  const { block, timeout } = options
  const startTime = Date.now()

  while (true) {
    const status = getTaskStatus(taskId)

    if (!status.found) {
      return status
    }

    if (status.status === 'completed' || !block) {
      return {
        task_id: taskId,
        status: status.status,
        output: status.output,
        completed: status.status === 'completed',
        duration: status.duration,
      }
    }

    if (Date.now() - startTime > timeout) {
      return {
        task_id: taskId,
        status: status.status,
        output: status.output,
        completed: false,
        timedOut: true,
        message: `Timed out after ${timeout}ms`,
      }
    }

    await sleep(CONFIG.POLL_INTERVAL)
  }
}

async function getBashBackgroundOutput(taskId, options) {
  const { block, timeout } = options
  const startTime = Date.now()

  while (true) {
    const status = getBackgroundStatus(taskId)

    if (!status.found) {
      return status
    }

    if (status.completed || !block) {
      return {
        task_id: taskId,
        status: status.completed ? 'completed' : 'running',
        output: status.output,
        completed: status.completed,
        exitCode: status.exitCode,
        duration: status.duration,
      }
    }

    if (Date.now() - startTime > timeout) {
      let currentOutput = ''
      if (status.outputFile && fs.existsSync(status.outputFile)) {
        currentOutput = fs.readFileSync(status.outputFile, 'utf-8')
      }

      return {
        task_id: taskId,
        status: 'running',
        output: currentOutput,
        completed: false,
        timedOut: true,
        message: `Timed out after ${timeout}ms`,
      }
    }

    await sleep(CONFIG.POLL_INTERVAL)
  }
}

/** Read an output file directly. */
function readOutputFile(outputFile) {
  if (!fs.existsSync(outputFile)) {
    return { found: false, error: `Output file not found: ${outputFile}` }
  }

  const output = fs.readFileSync(outputFile, 'utf-8')

  return {
    found: true,
    output_file: outputFile,
    output,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    noBlock: args.includes('--no-block'),
  }

  let timeout = CONFIG.DEFAULT_TIMEOUT
  let outputFile = null

  const timeoutIdx = args.indexOf('--timeout')
  if (timeoutIdx !== -1) timeout = parseInt(args[timeoutIdx + 1], 10)

  const fileIdx = args.indexOf('--file')
  if (fileIdx !== -1) outputFile = args[fileIdx + 1]

  const taskId = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (idx > 0 && ['--timeout', '--file'].includes(args[idx - 1])) return false
    return true
  })

  if (flags.help || (!taskId && !outputFile)) {
    console.log(`
TaskOutput — fetch a task or background shell's output

Usage:
  bun task-output.js <task_id> [options]

Arguments:
  task_id          Task id (task-xxx or bg-xxx)

Options:
  --timeout <ms>   Timeout when blocking (default: ${CONFIG.DEFAULT_TIMEOUT})
  --no-block       Return immediately with current state
  --file <path>    Read an output file directly
  --json           Output JSON
  --help           Show this help

Examples:
  bun task-output.js task-1-1234567890
  bun task-output.js bg-1-1234567890 --no-block
  bun task-output.js task-1-xxx --timeout 60000
  bun task-output.js --file /tmp/agent-task-output/task-1-xxx.log
`)
    process.exit(0)
  }

  try {
    let result

    if (outputFile) {
      result = readOutputFile(outputFile)
    } else {
      result = await getTaskOutput(taskId, {
        block: !flags.noBlock,
        timeout,
      })
    }

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (!result.found) {
        console.error('Error:', result.error)
        process.exit(1)
      }

      console.log(`Task: ${result.task_id || outputFile}`)
      console.log(`Status: ${result.status || 'file read'}`)

      if (result.completed !== undefined) {
        console.log(`Completed: ${result.completed}`)
      }

      if (result.duration) {
        console.log(`Duration: ${result.duration}ms`)
      }

      if (result.exitCode !== undefined) {
        console.log(`Exit code: ${result.exitCode}`)
      }

      if (result.timedOut) {
        console.log(`[Timed out: ${result.message}]`)
      }

      if (result.output) {
        console.log('---')
        console.log(result.output)
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { getTaskOutput, readOutputFile }

if (import.meta.main) {
  main()
}
