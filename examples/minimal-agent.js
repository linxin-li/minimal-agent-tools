#!/usr/bin/env bun
/**
 * Minimal agent loop using a few tools from minimal-agent-tools + the
 * Anthropic SDK. Demonstrates the canonical "model-calls-tools" pattern
 * in ~50 lines.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun examples/minimal-agent.js "list TS files in src"
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFile } from '../src/read.js'
import { glob } from '../src/glob.js'
import { bashExecute } from '../src/bash.js'

const client = new Anthropic()

const TOOLS = [
  {
    name: 'read',
    description: 'Read a file with optional offset/limit. file_path must be absolute.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.ts").',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Search root, defaults to cwd' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Run a shell command and return its stdout/stderr.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
  },
]

async function runTool(name, input) {
  switch (name) {
    case 'read':
      return readFile(input.file_path, { offset: input.offset, limit: input.limit })
    case 'glob':
      return glob(input.pattern, { path: input.path })
    case 'bash':
      return await bashExecute(input.command, { timeout: 30_000 })
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

async function main() {
  const userPrompt = process.argv.slice(2).join(' ') || 'List the TypeScript files in src/'

  const messages = [{ role: 'user', content: userPrompt }]

  for (let turn = 0; turn < 8; turn++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      tools: TOOLS,
      messages,
    })

    messages.push({ role: 'assistant', content: response.content })

    if (response.stop_reason !== 'tool_use') {
      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      console.log('\n--- Final answer ---\n' + text)
      return
    }

    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      console.log(`\n[tool] ${block.name}(${JSON.stringify(block.input).slice(0, 80)}...)`)
      const result = await runTool(block.name, block.input)
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result).slice(0, 4000),
      })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  console.log('\n[Hit max turns]')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
