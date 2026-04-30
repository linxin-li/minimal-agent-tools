#!/usr/bin/env bun
/**
 * KillShell — terminate a background shell process started by bash.js,
 * or any process by PID.
 */

import { getBackgroundStatus, killBackgroundProcess, listBackgroundProcesses } from './bash.js'

/**
 * Kill a background shell or process.
 *
 * @param {string} shellId - Either a `bg-N-timestamp` id (from bash.js --background),
 *                           or a numeric PID.
 */
function killShell(shellId) {
  if (!shellId) {
    return { success: false, error: 'shell_id is required' }
  }

  // Numeric → treat as PID.
  if (/^\d+$/.test(shellId)) {
    return killByPid(parseInt(shellId, 10))
  }

  // bg-N-timestamp → look up in the bash registry.
  if (/^bg-\d+-\d+$/.test(shellId)) {
    const status = getBackgroundStatus(shellId)
    if (!status.found) {
      return { success: false, error: `Process not found: ${shellId}` }
    }
    return killBackgroundProcess(shellId)
  }

  return { success: false, error: `Invalid shell_id format: ${shellId}` }
}

/**
 * SIGTERM a process by PID, escalating to SIGKILL after 1 s.
 */
function killByPid(pid) {
  try {
    process.kill(pid, 'SIGTERM')

    setTimeout(() => {
      try {
        process.kill(pid, 0) // probe
        process.kill(pid, 'SIGKILL')
      } catch {
        // process already gone — fine
      }
    }, 1000)

    return { success: true, pid, message: `Sent SIGTERM to process ${pid}` }
  } catch (error) {
    if (error.code === 'ESRCH') {
      return { success: false, error: `Process ${pid} not found` }
    }
    if (error.code === 'EPERM') {
      return { success: false, error: `Permission denied to kill process ${pid}` }
    }
    return { success: false, error: error.message }
  }
}

function listKillableProcesses() {
  return listBackgroundProcesses().filter((p) => p.running)
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    list: args.includes('--list') || args.includes('-l'),
  }

  const shellId = args.find((arg) => !arg.startsWith('-'))

  if (flags.help || (!shellId && !flags.list)) {
    console.log(`
KillShell — terminate a background shell or PID

Usage:
  bun kill-shell.js <shell_id> [options]

Arguments:
  shell_id     Process to terminate. Either:
               - background id (e.g. bg-1-1234567890)
               - raw PID (e.g. 12345)

Options:
  --list, -l   List killable background processes
  --json       Output JSON
  --help       Show this help

Examples:
  bun kill-shell.js bg-1-1234567890
  bun kill-shell.js 12345
  bun kill-shell.js --list
`)
    process.exit(0)
  }

  try {
    if (flags.list) {
      const processes = listKillableProcesses()

      if (flags.json) {
        console.log(JSON.stringify(processes, null, 2))
      } else {
        console.log('Running background processes:')
        if (processes.length === 0) {
          console.log('  (none)')
        } else {
          for (const p of processes) {
            console.log(`  ${p.processId} (PID: ${p.pid}): ${p.command}`)
          }
        }
      }
      return
    }

    const result = killShell(shellId)

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.success) {
        console.log(`Successfully killed: ${shellId}`)
        if (result.pid) {
          console.log(`PID: ${result.pid}`)
        }
        if (result.message) {
          console.log(result.message)
        }
      } else {
        console.error('Error:', result.error)
        process.exit(1)
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { killShell, killByPid, listKillableProcesses }

if (import.meta.main) {
  main()
}
