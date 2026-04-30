#!/usr/bin/env bun
/**
 * Bash — execute shell commands with timeout, output cap, and background mode.
 *
 * Output is capped to MAX_OUTPUT_SIZE so a runaway command can't blow past the
 * model's context window. Background mode writes to a temp file and returns a
 * processId you can poll later.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const CONFIG = {
  DEFAULT_TIMEOUT: 120000, // 2 min
  MAX_TIMEOUT: 600000, // 10 min
  MAX_OUTPUT_SIZE: 30000, // characters
  SHELL: process.env.SHELL || '/bin/bash',
  BACKGROUND_OUTPUT_DIR: path.join(os.tmpdir(), 'agent-bash-output'),
}

// In-process registry of detached background commands.
const backgroundProcesses = new Map()
let processIdCounter = 0

/**
 * Execute a shell command.
 *
 * @param {string} command
 * @param {Object} [options]
 * @param {number} [options.timeout] - ms; clamped to MAX_TIMEOUT.
 * @param {string} [options.cwd]
 * @param {boolean} [options.runInBackground] - Detach and return immediately.
 */
async function bashExecute(command, options = {}) {
  const { timeout = CONFIG.DEFAULT_TIMEOUT, cwd = process.cwd(), runInBackground = false } = options

  const actualTimeout = Math.min(timeout, CONFIG.MAX_TIMEOUT)

  if (runInBackground) {
    return runBackgroundCommand(command, { cwd, timeout: actualTimeout })
  }

  return runForegroundCommand(command, { cwd, timeout: actualTimeout })
}

function runForegroundCommand(command, options) {
  const { cwd, timeout } = options

  return new Promise((resolve) => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''
    let killed = false

    const proc = spawn(CONFIG.SHELL, ['-c', command], {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
      // Escalate to SIGKILL if SIGTERM doesn't take.
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
      }, 1000)
    }, timeout)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
      if (stdout.length > CONFIG.MAX_OUTPUT_SIZE) {
        stdout = stdout.substring(0, CONFIG.MAX_OUTPUT_SIZE) + '\n[Output truncated...]'
      }
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
      if (stderr.length > CONFIG.MAX_OUTPUT_SIZE) {
        stderr = stderr.substring(0, CONFIG.MAX_OUTPUT_SIZE) + '\n[Output truncated...]'
      }
    })

    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      const duration = Date.now() - startTime

      resolve({
        success: code === 0,
        exitCode: code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output: (stdout + (stderr ? '\n' + stderr : '')).trim(),
        duration,
        timedOut: killed,
        command,
      })
    })

    proc.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        success: false,
        exitCode: null,
        error: error.message,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        output: stderr.trim() || error.message,
        duration: Date.now() - startTime,
        timedOut: false,
        command,
      })
    })
  })
}

function runBackgroundCommand(command, options) {
  const { cwd, timeout } = options

  if (!fs.existsSync(CONFIG.BACKGROUND_OUTPUT_DIR)) {
    fs.mkdirSync(CONFIG.BACKGROUND_OUTPUT_DIR, { recursive: true })
  }

  const processId = `bg-${++processIdCounter}-${Date.now()}`
  const outputFile = path.join(CONFIG.BACKGROUND_OUTPUT_DIR, `${processId}.log`)

  return new Promise((resolve) => {
    const startTime = Date.now()

    const proc = spawn(CONFIG.SHELL, ['-c', command], {
      cwd,
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const writeStream = fs.createWriteStream(outputFile)
    proc.stdout.pipe(writeStream)
    proc.stderr.pipe(writeStream)

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      writeStream.write('\n[Process timed out and was terminated]')
    }, timeout)

    backgroundProcesses.set(processId, {
      pid: proc.pid,
      command,
      startTime,
      outputFile,
      process: proc,
      timer,
    })

    resolve({
      success: true,
      background: true,
      processId,
      pid: proc.pid,
      outputFile,
      message: `Command started in background. Use getBackgroundStatus("${processId}") to check status.`,
    })

    proc.on('close', (code, signal) => {
      clearTimeout(timer)
      const info = backgroundProcesses.get(processId)
      if (info) {
        info.exitCode = code
        info.signal = signal
        info.endTime = Date.now()
        info.duration = info.endTime - info.startTime
      }
    })

    proc.unref()
  })
}

/**
 * Look up a background command by id and return its status (and output if finished).
 */
function getBackgroundStatus(processId) {
  const info = backgroundProcesses.get(processId)

  if (!info) {
    return { found: false, error: `Process not found: ${processId}` }
  }

  const status = {
    found: true,
    processId,
    pid: info.pid,
    command: info.command,
    startTime: info.startTime,
    outputFile: info.outputFile,
  }

  if (info.endTime) {
    status.completed = true
    status.exitCode = info.exitCode
    status.signal = info.signal
    status.duration = info.duration

    if (fs.existsSync(info.outputFile)) {
      status.output = fs.readFileSync(info.outputFile, 'utf-8')
      if (status.output.length > CONFIG.MAX_OUTPUT_SIZE) {
        status.output =
          status.output.substring(0, CONFIG.MAX_OUTPUT_SIZE) + '\n[Output truncated...]'
      }
    }
  } else {
    status.completed = false
    status.running = true
  }

  return status
}

/** Send SIGTERM to a background command, escalating to SIGKILL after 1 s. */
function killBackgroundProcess(processId) {
  const info = backgroundProcesses.get(processId)

  if (!info) {
    return { success: false, error: `Process not found: ${processId}` }
  }

  if (info.endTime) {
    return { success: false, error: 'Process already completed' }
  }

  try {
    clearTimeout(info.timer)
    info.process.kill('SIGTERM')

    setTimeout(() => {
      if (!info.process.killed) {
        info.process.kill('SIGKILL')
      }
    }, 1000)

    return { success: true, processId, pid: info.pid }
  } catch (error) {
    return { success: false, error: error.message }
  }
}

function listBackgroundProcesses() {
  const list = []

  for (const [processId, info] of backgroundProcesses) {
    list.push({
      processId,
      pid: info.pid,
      command: info.command.substring(0, 50),
      running: !info.endTime,
      exitCode: info.exitCode,
    })
  }

  return list
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    background: args.includes('--background') || args.includes('-b'),
    list: args.includes('--list') || args.includes('-l'),
    status: args.includes('--status'),
    kill: args.includes('--kill'),
  }

  let timeout = CONFIG.DEFAULT_TIMEOUT
  let cwd = process.cwd()

  const timeoutIdx = args.indexOf('--timeout')
  if (timeoutIdx !== -1) timeout = parseInt(args[timeoutIdx + 1], 10)

  const cwdIdx = args.indexOf('--cwd')
  if (cwdIdx !== -1) cwd = args[cwdIdx + 1]

  const statusIdx = args.indexOf('--status')
  const statusProcessId = statusIdx !== -1 ? args[statusIdx + 1] : null

  const killIdx = args.indexOf('--kill')
  const killProcessId = killIdx !== -1 ? args[killIdx + 1] : null

  const command = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (idx > 0 && ['--timeout', '--cwd', '--status', '--kill'].includes(args[idx - 1]))
      return false
    return true
  })

  if (flags.help || (!command && !flags.list && !statusProcessId && !killProcessId)) {
    console.log(`
Bash — minimal shell runner

Usage:
  bun bash.js <command> [options]

Options:
  --timeout <ms>   Timeout (default: ${CONFIG.DEFAULT_TIMEOUT}, max: ${CONFIG.MAX_TIMEOUT})
  --cwd <dir>      Working directory
  --background, -b Run in background
  --list, -l       List background processes
  --status <id>    Show background process status
  --kill <id>      Kill a background process
  --json           Output JSON
  --help           Show this help

Examples:
  bun bash.js "ls -la"
  bun bash.js "npm install" --timeout 300000
  bun bash.js "npm test" --background
  bun bash.js --list
  bun bash.js --status bg-1-1234567890
  bun bash.js --kill bg-1-1234567890
`)
    process.exit(0)
  }

  try {
    if (flags.list) {
      const list = listBackgroundProcesses()
      if (flags.json) {
        console.log(JSON.stringify(list, null, 2))
      } else {
        console.log('Background processes:')
        if (list.length === 0) {
          console.log('  (none)')
        } else {
          for (const p of list) {
            const status = p.running ? 'running' : `exited (${p.exitCode})`
            console.log(`  ${p.processId} [${status}]: ${p.command}`)
          }
        }
      }
      return
    }

    if (statusProcessId) {
      const status = getBackgroundStatus(statusProcessId)
      if (flags.json) {
        console.log(JSON.stringify(status, null, 2))
      } else {
        if (!status.found) {
          console.error('Error:', status.error)
          process.exit(1)
        }
        console.log(`Process: ${status.processId}`)
        console.log(`PID: ${status.pid}`)
        console.log(`Command: ${status.command}`)
        console.log(`Status: ${status.completed ? 'completed' : 'running'}`)
        if (status.completed) {
          console.log(`Exit code: ${status.exitCode}`)
          console.log(`Duration: ${status.duration}ms`)
          if (status.output) {
            console.log('---')
            console.log(status.output)
          }
        }
      }
      return
    }

    if (killProcessId) {
      const result = killBackgroundProcess(killProcessId)
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (result.success) {
          console.log(`Killed process: ${result.processId} (PID: ${result.pid})`)
        } else {
          console.error('Error:', result.error)
          process.exit(1)
        }
      }
      return
    }

    const result = await bashExecute(command, {
      timeout,
      cwd,
      runInBackground: flags.background,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.background) {
        console.log(`Started in background: ${result.processId}`)
        console.log(`PID: ${result.pid}`)
        console.log(`Output file: ${result.outputFile}`)
      } else {
        if (result.output) {
          console.log(result.output)
        }
        if (!result.success) {
          if (result.timedOut) {
            console.error(`\n[Command timed out after ${timeout}ms]`)
          }
          process.exit(result.exitCode || 1)
        }
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { bashExecute, getBackgroundStatus, killBackgroundProcess, listBackgroundProcesses }

if (import.meta.main) {
  main()
}
