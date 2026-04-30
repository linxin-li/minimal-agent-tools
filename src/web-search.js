#!/usr/bin/env bun
/**
 * WebSearch — wrap Anthropic's native `web_search` tool.
 *
 * Pattern: don't roll your own search scraper. The model providers ship a
 * server-side web_search tool that handles indexing, ranking, and snippet
 * extraction better than anything you'd build in a weekend.
 *
 * Set ANTHROPIC_API_KEY. This module sends a Messages API request with the
 * `web_search_20250305` tool enabled, parses the result, and returns links
 * + the model's synthesized answer.
 */

import https from 'node:https'

const CONFIG = {
  API_URL: 'https://api.anthropic.com/v1/messages',
  API_VERSION: '2023-06-01',
  MODEL: 'claude-sonnet-4-20250514', // any model that supports web_search
  MAX_TOKENS: 4096,
  MAX_SEARCH_USES: 8,
}

function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: options.method || 'POST',
        headers: options.headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf-8')
          resolve({ status: res.statusCode, data })
        })
      },
    )

    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * Perform a web search via the Anthropic Messages API.
 *
 * @param {string} query
 * @param {Object} [options]
 * @param {string} [options.apiKey] - Falls back to ANTHROPIC_API_KEY env var.
 * @param {string} [options.model]
 * @param {number} [options.maxTokens]
 * @param {number} [options.maxUses]
 * @param {string[]} [options.allowed_domains] - Mutually exclusive with blocked_domains.
 * @param {string[]} [options.blocked_domains]
 */
async function webSearch(query, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set')
  }

  if (!query || query.length < 2) {
    throw new Error('Query must be at least 2 characters')
  }

  if (options.allowed_domains?.length && options.blocked_domains?.length) {
    throw new Error('Cannot specify both allowed_domains and blocked_domains')
  }

  console.log(`[WebSearch] Searching for: "${query}"`)
  const startTime = performance.now()

  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: options.maxUses || CONFIG.MAX_SEARCH_USES,
  }

  if (options.allowed_domains?.length) {
    webSearchTool.allowed_domains = options.allowed_domains
  }
  if (options.blocked_domains?.length) {
    webSearchTool.blocked_domains = options.blocked_domains
  }

  const requestBody = JSON.stringify({
    model: options.model || CONFIG.MODEL,
    max_tokens: options.maxTokens || CONFIG.MAX_TOKENS,
    stream: false,
    tools: [webSearchTool],
    messages: [
      {
        role: 'user',
        content: `Perform a web search for: ${query}`,
      },
    ],
  })

  console.log('[WebSearch] Calling Anthropic API with web_search tool...')

  const response = await httpRequest(
    CONFIG.API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CONFIG.API_VERSION,
      },
    },
    requestBody,
  )

  if (response.status !== 200) {
    throw new Error(`API request failed (${response.status}): ${response.data}`)
  }

  const responseBody = JSON.parse(response.data)

  const results = []
  let textContent = ''

  for (const block of responseBody.content || []) {
    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        const links = block.content.map((item) => ({
          title: item.title,
          url: item.url,
          snippet: item.page_content?.substring(0, 200),
        }))
        results.push({
          tool_use_id: block.tool_use_id,
          content: links,
        })
      } else if (block.content?.error_code) {
        results.push(`Web search error: ${block.content.error_code}`)
      }
    }

    if (block.type === 'text') {
      textContent += block.text || ''
    }
  }

  if (textContent.trim()) {
    results.push(textContent.trim())
  }

  const durationSeconds = (performance.now() - startTime) / 1000

  console.log(`[WebSearch] Completed in ${durationSeconds.toFixed(2)}s`)

  return {
    query,
    results,
    durationSeconds,
    usage: responseBody.usage,
  }
}

function formatResults(searchResult) {
  let output = `Web search results for query: "${searchResult.query}"\n\n`

  for (const result of searchResult.results) {
    if (typeof result === 'string') {
      output += result + '\n\n'
    } else if (result.content?.length > 0) {
      output += 'Links:\n'
      for (const link of result.content) {
        output += `  - ${link.title}\n`
        output += `    ${link.url}\n`
        if (link.snippet) {
          output += `    ${link.snippet}...\n`
        }
      }
      output += '\n'
    } else {
      output += 'No links found.\n\n'
    }
  }

  return output.trim()
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
  }

  let allowedDomains = []
  let blockedDomains = []

  const allowIdx = args.indexOf('--allow')
  if (allowIdx !== -1 && args[allowIdx + 1]) {
    allowedDomains = args[allowIdx + 1].split(',')
  }

  const blockIdx = args.indexOf('--block')
  if (blockIdx !== -1 && args[blockIdx + 1]) {
    blockedDomains = args[blockIdx + 1].split(',')
  }

  const positionalArgs = args.filter((arg, idx) => {
    if (arg.startsWith('--') || arg.startsWith('-')) return false
    if (idx > 0 && (args[idx - 1] === '--allow' || args[idx - 1] === '--block')) return false
    return true
  })

  if (positionalArgs.length === 0 || flags.help) {
    console.log(`
WebSearch — wraps Anthropic's native web_search tool

Usage:
  bun web-search.js <query> [options]

Arguments:
  query    Search query (≥ 2 chars)

Options:
  --allow <domains>  Restrict to these domains (comma-separated)
  --block <domains>  Exclude these domains (comma-separated)
  --json             Output JSON
  --help             Show this help

Environment:
  ANTHROPIC_API_KEY  Required.

Examples:
  bun web-search.js "Node.js best practices 2025"
  bun web-search.js "React hooks" --allow "react.dev,github.com"
  bun web-search.js "JavaScript tutorial" --block "w3schools.com"

How it works:
  1. POST to Anthropic Messages API with the web_search_20250305 tool enabled.
  2. The API performs the search server-side and returns links + a synthesized answer.
  3. We parse the structured tool result + text content and return both.

Notes:
  - Search is run by Anthropic, not a third-party search API.
  - Requires a model that supports web_search (Claude 3+).
`)
    process.exit(0)
  }

  const query = positionalArgs.join(' ')

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required.')
    console.error('Set it with: export ANTHROPIC_API_KEY=your-key')
    process.exit(1)
  }

  try {
    const result = await webSearch(query, {
      allowed_domains: allowedDomains.length ? allowedDomains : undefined,
      blocked_domains: blockedDomains.length ? blockedDomains : undefined,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log('\n' + '='.repeat(60))
      console.log(`Query: ${result.query}`)
      console.log(`Duration: ${result.durationSeconds.toFixed(2)}s`)
      if (result.usage) {
        console.log(`Tokens: ${result.usage.input_tokens} in, ${result.usage.output_tokens} out`)
      }
      console.log('='.repeat(60) + '\n')

      console.log(formatResults(result))
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { webSearch, formatResults }

if (import.meta.main) {
  main()
}
