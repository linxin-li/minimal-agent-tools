#!/usr/bin/env bun
/**
 * Task — spawn a sub-agent / sub-task to handle a focused piece of work.
 *
 * NOTE: This is the *registry + lifecycle skeleton*. Plugging in an actual sub-agent
 * runner (LLM call loop, tool use, max-turns enforcement) is left to the caller —
 * the comments inside `executeTaskSync` / `executeTaskAsync` mark where it goes.
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const CONFIG = {
  OUTPUT_DIR: path.join(os.tmpdir(), 'agent-task-output'),
  DEFAULT_MAX_TURNS: 10,
  AGENT_TYPES: [
    'Bash',
    'general-purpose',
    'Explore',
    'Plan',
  ],
}

const tasks = new Map()
let taskIdCounter = 0

/**
 * Create and start a task.
 *
 * @param {Object} params
 * @param {string} params.description - Short label, 3-5 words.
 * @param {string} params.prompt - Full task prompt for the sub-agent.
 * @param {string} [params.subagent_type='general-purpose']
 * @param {boolean} [params.run_in_background=false]
 * @param {number} [params.max_turns]
 */
function createTask(params) {
  const {
    description,
    prompt,
    subagent_type = 'general-purpose',
    run_in_background = false,
    max_turns = CONFIG.DEFAULT_MAX_TURNS,
    model,
    mode,
  } = params

  if (!description) {
    throw new Error('description is required')
  }
  if (!prompt) {
    throw new Error('prompt is required')
  }

  if (!CONFIG.AGENT_TYPES.includes(subagent_type)) {
    console.warn(
      `Warning: Unknown subagent_type "${subagent_type}". Known types: ${CONFIG.AGENT_TYPES.join(', ')}`,
    )
  }

  if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true })
  }

  const taskId = `task-${++taskIdCounter}-${Date.now()}`
  const outputFile = path.join(CONFIG.OUTPUT_DIR, `${taskId}.log`)

  const task = {
    id: taskId,
    description,
    prompt,
    subagent_type,
    max_turns,
    model,
    mode,
    status: 'pending',
    startTime: Date.now(),
    outputFile,
    run_in_background,
  }

  tasks.set(taskId, task)

  if (run_in_background) {
    executeTaskAsync(task)
    return {
      task_id: taskId,
      status: 'started',
      run_in_background: true,
      output_file: outputFile,
      message: `Task "${description}" started in background. Use getTaskStatus("${taskId}") to check progress.`,
    }
  } else {
    return executeTaskSync(task)
  }
}

function executeTaskSync(task) {
  task.status = 'running'

  const taskInfo = `
=== Task: ${task.description} ===
Agent Type: ${task.subagent_type}
Started: ${new Date(task.startTime).toISOString()}

Prompt:
${task.prompt}

---
[Skeleton implementation. Plug in your sub-agent runner here.]
[The runner should accept the prompt + tools, loop up to max_turns, and write progress to outputFile.]
---
`

  fs.writeFileSync(task.outputFile, taskInfo, 'utf-8')

  task.status = 'completed'
  task.endTime = Date.now()

  return {
    task_id: task.id,
    status: 'completed',
    result: taskInfo,
    duration: task.endTime - task.startTime,
    output_file: task.outputFile,
  }
}

function executeTaskAsync(task) {
  task.status = 'running'

  const startInfo = `
=== Task: ${task.description} ===
Agent Type: ${task.subagent_type}
Started: ${new Date(task.startTime).toISOString()}
Status: Running in background...

Prompt:
${task.prompt}

---
`

  fs.writeFileSync(task.outputFile, startInfo, 'utf-8')

  setTimeout(() => {
    const endInfo = `
---
[Skeleton implementation — plug in your sub-agent runner here.]
Completed: ${new Date().toISOString()}
Duration: ${Date.now() - task.startTime}ms
`

    fs.appendFileSync(task.outputFile, endInfo, 'utf-8')
    task.status = 'completed'
    task.endTime = Date.now()
  }, 2000)
}

function getTaskStatus(taskId) {
  const task = tasks.get(taskId)

  if (!task) {
    return { found: false, error: `Task not found: ${taskId}` }
  }

  const result = {
    found: true,
    task_id: task.id,
    description: task.description,
    subagent_type: task.subagent_type,
    status: task.status,
    startTime: task.startTime,
    output_file: task.outputFile,
  }

  if (task.endTime) {
    result.endTime = task.endTime
    result.duration = task.endTime - task.startTime
  }

  if (fs.existsSync(task.outputFile)) {
    result.output = fs.readFileSync(task.outputFile, 'utf-8')
  }

  return result
}

function listTasks() {
  const list = []

  for (const [taskId, task] of tasks) {
    list.push({
      task_id: taskId,
      description: task.description,
      subagent_type: task.subagent_type,
      status: task.status,
      startTime: task.startTime,
      endTime: task.endTime,
    })
  }

  return list
}

/** Append additional input to an existing task's output stream. */
function resumeTask(taskId, additionalPrompt = '') {
  const task = tasks.get(taskId)

  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }

  const resumeInfo = `
---
[Resumed at ${new Date().toISOString()}]
${additionalPrompt ? 'Additional prompt: ' + additionalPrompt : ''}
---
`

  fs.appendFileSync(task.outputFile, resumeInfo, 'utf-8')
  task.status = 'running'

  return {
    task_id: taskId,
    status: 'resumed',
    message: `Task "${task.description}" resumed.`,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    list: args.includes('--list') || args.includes('-l'),
    background: args.includes('--background') || args.includes('-b'),
  }

  let description = ''
  let prompt = ''
  let subagentType = 'general-purpose'
  let maxTurns = CONFIG.DEFAULT_MAX_TURNS
  let resume = null

  const descIdx = args.indexOf('--description')
  if (descIdx !== -1) description = args[descIdx + 1]

  const promptIdx = args.indexOf('--prompt')
  if (promptIdx !== -1) prompt = args[promptIdx + 1]

  const typeIdx = args.indexOf('--type')
  if (typeIdx !== -1) subagentType = args[typeIdx + 1]

  const turnsIdx = args.indexOf('--max-turns')
  if (turnsIdx !== -1) maxTurns = parseInt(args[turnsIdx + 1], 10)

  const resumeIdx = args.indexOf('--resume')
  if (resumeIdx !== -1) resume = args[resumeIdx + 1]

  if (flags.help) {
    console.log(`
Task — spawn a sub-agent task

Usage:
  bun task.js --description <desc> --prompt <prompt> [options]

Options:
  --description <text>  Short label (3-5 words)
  --prompt <text>       Full task prompt for the sub-agent
  --type <type>         Agent type (${CONFIG.AGENT_TYPES.join(', ')})
  --max-turns <n>       Max LLM turns (default: ${CONFIG.DEFAULT_MAX_TURNS})
  --background, -b      Run in background
  --resume <task_id>    Resume an existing task
  --list, -l            List all tasks
  --json                Output JSON
  --help                Show this help

Examples:
  bun task.js --description "Explore repo" --prompt "Map the project layout" --type Explore
  bun task.js --description "Run tests" --prompt "Execute the test suite" --type Bash -b
  bun task.js --list

Note:
  This is the registry/lifecycle skeleton. Plug in your own sub-agent runner
  (LLM loop + tool use) where indicated in the source.
`)
    process.exit(0)
  }

  try {
    if (flags.list) {
      const taskList = listTasks()

      if (flags.json) {
        console.log(JSON.stringify(taskList, null, 2))
      } else {
        console.log('Tasks:')
        if (taskList.length === 0) {
          console.log('  (none)')
        } else {
          for (const t of taskList) {
            console.log(`  ${t.task_id} [${t.status}] (${t.subagent_type}): ${t.description}`)
          }
        }
      }
      return
    }

    if (resume) {
      const result = resumeTask(resume, prompt)

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(result.message)
      }
      return
    }

    if (!description || !prompt) {
      console.error('Error: --description and --prompt are required')
      process.exit(1)
    }

    const result = createTask({
      description,
      prompt,
      subagent_type: subagentType,
      max_turns: maxTurns,
      run_in_background: flags.background,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Task ID: ${result.task_id}`)
      console.log(`Status: ${result.status}`)
      if (result.run_in_background) {
        console.log(`Output file: ${result.output_file}`)
        console.log(result.message)
      } else if (result.result) {
        console.log('---')
        console.log(result.result)
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { createTask, getTaskStatus, listTasks, resumeTask, tasks }

if (import.meta.main) {
  main()
}
