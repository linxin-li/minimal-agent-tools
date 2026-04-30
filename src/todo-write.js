#!/usr/bin/env bun
/**
 * TodoWrite — persistent todo-list management for an agent.
 *
 * Stores items as JSON in TODO_FILE (in tmpdir by default). The agent reads it
 * back later to track in-flight work across turns.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIG = {
  TODO_FILE: path.join(os.tmpdir(), 'agent-todo.json'),
  STATUSES: ['pending', 'in_progress', 'completed'],
}

function loadTodos() {
  if (!fs.existsSync(CONFIG.TODO_FILE)) {
    return []
  }

  try {
    const content = fs.readFileSync(CONFIG.TODO_FILE, 'utf-8')
    return JSON.parse(content)
  } catch {
    console.warn('Warning: Could not parse todo file, starting fresh')
    return []
  }
}

function saveTodos(todos) {
  fs.writeFileSync(CONFIG.TODO_FILE, JSON.stringify(todos, null, 2), 'utf-8')
}

function generateId() {
  return `todo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Create a new todo.
 * @param {{ subject: string, description?: string, status?: string }} params
 */
function createTodo(params) {
  const { subject, description = '', status = 'pending' } = params

  if (!subject) {
    throw new Error('subject is required')
  }

  if (!CONFIG.STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}. Valid: ${CONFIG.STATUSES.join(', ')}`)
  }

  const todos = loadTodos()

  const todo = {
    id: generateId(),
    subject,
    description,
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  todos.push(todo)
  saveTodos(todos)

  return {
    success: true,
    action: 'created',
    todo,
  }
}

/**
 * Update one or more fields of an existing todo.
 */
function updateTodo(id, updates) {
  if (!id) {
    throw new Error('id is required')
  }

  const todos = loadTodos()
  const index = todos.findIndex((t) => t.id === id)

  if (index === -1) {
    throw new Error(`Todo not found: ${id}`)
  }

  const todo = todos[index]

  if (updates.subject !== undefined) {
    todo.subject = updates.subject
  }
  if (updates.description !== undefined) {
    todo.description = updates.description
  }
  if (updates.status !== undefined) {
    if (!CONFIG.STATUSES.includes(updates.status)) {
      throw new Error(`Invalid status: ${updates.status}`)
    }
    todo.status = updates.status
  }

  todo.updatedAt = new Date().toISOString()

  saveTodos(todos)

  return {
    success: true,
    action: 'updated',
    todo,
  }
}

function deleteTodo(id) {
  if (!id) {
    throw new Error('id is required')
  }

  const todos = loadTodos()
  const index = todos.findIndex((t) => t.id === id)

  if (index === -1) {
    throw new Error(`Todo not found: ${id}`)
  }

  const deleted = todos.splice(index, 1)[0]
  saveTodos(todos)

  return {
    success: true,
    action: 'deleted',
    todo: deleted,
  }
}

function getTodo(id) {
  const todos = loadTodos()
  const todo = todos.find((t) => t.id === id)

  if (!todo) {
    return { found: false, error: `Todo not found: ${id}` }
  }

  return { found: true, todo }
}

/**
 * @param {{ status?: string }} [options] - Filter by status if provided.
 */
function listTodos(options = {}) {
  const { status } = options
  let todos = loadTodos()

  if (status) {
    todos = todos.filter((t) => t.status === status)
  }

  return {
    todos,
    total: todos.length,
    byStatus: {
      pending: todos.filter((t) => t.status === 'pending').length,
      in_progress: todos.filter((t) => t.status === 'in_progress').length,
      completed: todos.filter((t) => t.status === 'completed').length,
    },
  }
}

/** Replace the entire todo list (the original "TodoWrite" semantics). */
function writeTodos(todos) {
  if (!Array.isArray(todos)) {
    throw new Error('todos must be an array')
  }

  const validatedTodos = todos.map((todo, idx) => {
    if (!todo.subject) {
      throw new Error(`Todo at index ${idx} missing subject`)
    }

    return {
      id: todo.id || generateId(),
      subject: todo.subject,
      description: todo.description || '',
      status: CONFIG.STATUSES.includes(todo.status) ? todo.status : 'pending',
      createdAt: todo.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  })

  saveTodos(validatedTodos)

  return {
    success: true,
    action: 'replaced',
    count: validatedTodos.length,
  }
}

function clearTodos() {
  saveTodos([])
  return { success: true, action: 'cleared' }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    list: args.includes('--list') || args.includes('-l'),
    create: args.includes('--create') || args.includes('-c'),
    update: args.includes('--update') || args.includes('-u'),
    delete: args.includes('--delete') || args.includes('-d'),
    get: args.includes('--get') || args.includes('-g'),
    clear: args.includes('--clear'),
  }

  let id = null
  let subject = ''
  let description = ''
  let status = 'pending'

  const idIdx = args.indexOf('--id')
  if (idIdx !== -1) id = args[idIdx + 1]

  const subjectIdx = args.indexOf('--subject')
  if (subjectIdx !== -1) subject = args[subjectIdx + 1]

  const descIdx = args.indexOf('--description')
  if (descIdx !== -1) description = args[descIdx + 1]

  const statusIdx = args.indexOf('--status')
  if (statusIdx !== -1) status = args[statusIdx + 1]

  if (flags.help) {
    console.log(`
TodoWrite — persistent todo list

Usage:
  bun todo-write.js [options]

Actions:
  --list, -l        List all todos
  --create, -c      Create a new todo
  --update, -u      Update an existing todo
  --delete, -d      Delete a todo
  --get, -g         Get a single todo
  --clear           Clear all todos

Arguments:
  --id <id>             Todo id (for update/delete/get)
  --subject <text>      Subject (for create/update)
  --description <text>  Description (for create/update)
  --status <status>     pending | in_progress | completed

Options:
  --json            Output JSON
  --help            Show this help

Examples:
  bun todo-write.js --create --subject "Implement feature" --description "Details"
  bun todo-write.js --list
  bun todo-write.js --list --status pending
  bun todo-write.js --update --id todo-xxx --status completed
  bun todo-write.js --delete --id todo-xxx

Storage:
  Todos persist at ${CONFIG.TODO_FILE}.
`)
    process.exit(0)
  }

  try {
    let result

    if (flags.list) {
      result = listTodos({ status: statusIdx !== -1 ? status : undefined })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(
          `Total: ${result.total} (pending: ${result.byStatus.pending}, in_progress: ${result.byStatus.in_progress}, completed: ${result.byStatus.completed})`,
        )
        console.log('---')
        for (const todo of result.todos) {
          console.log(`[${todo.status}] ${todo.id}`)
          console.log(`  Subject: ${todo.subject}`)
          if (todo.description) {
            console.log(
              `  Description: ${todo.description.substring(0, 50)}${todo.description.length > 50 ? '...' : ''}`,
            )
          }
        }
      }
    } else if (flags.create) {
      if (!subject) {
        console.error('Error: --subject is required for create')
        process.exit(1)
      }
      result = createTodo({ subject, description, status })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`Created: ${result.todo.id}`)
        console.log(`Subject: ${result.todo.subject}`)
        console.log(`Status: ${result.todo.status}`)
      }
    } else if (flags.update) {
      if (!id) {
        console.error('Error: --id is required for update')
        process.exit(1)
      }
      const updates = {}
      if (subjectIdx !== -1) updates.subject = subject
      if (descIdx !== -1) updates.description = description
      if (statusIdx !== -1) updates.status = status

      result = updateTodo(id, updates)

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`Updated: ${result.todo.id}`)
        console.log(`Status: ${result.todo.status}`)
      }
    } else if (flags.delete) {
      if (!id) {
        console.error('Error: --id is required for delete')
        process.exit(1)
      }
      result = deleteTodo(id)

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`Deleted: ${result.todo.id}`)
      }
    } else if (flags.get) {
      if (!id) {
        console.error('Error: --id is required for get')
        process.exit(1)
      }
      result = getTodo(id)

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.found) {
          console.error('Error:', result.error)
          process.exit(1)
        }
        console.log(`ID: ${result.todo.id}`)
        console.log(`Subject: ${result.todo.subject}`)
        console.log(`Description: ${result.todo.description || '(none)'}`)
        console.log(`Status: ${result.todo.status}`)
        console.log(`Created: ${result.todo.createdAt}`)
        console.log(`Updated: ${result.todo.updatedAt}`)
      }
    } else if (flags.clear) {
      result = clearTodos()

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log('All todos cleared')
      }
    } else {
      result = listTodos()
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`Total: ${result.total} todos`)
        console.log('Use --help for usage information')
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export {
  createTodo,
  updateTodo,
  deleteTodo,
  getTodo,
  listTodos,
  writeTodos,
  clearTodos,
  loadTodos,
  saveTodos,
}

if (import.meta.main) {
  main()
}
