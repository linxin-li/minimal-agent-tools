#!/usr/bin/env bun
/**
 * WebFetch — fetch a URL, convert to Markdown, optionally summarize with an LLM.
 *
 * Pattern: "fetch + HTML→Markdown + optional AI summarization" beats sending
 * raw HTML to the model — the cleanup step alone usually pays for itself in
 * tokens.
 *
 * Set ANTHROPIC_API_KEY (or pass apiKey in options) to enable AI summarization.
 * Use --no-ai to skip it and return the markdown directly.
 */

import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'

const CONFIG = {
  MAX_URL_LENGTH: 2000,
  MAX_CONTENT_LENGTH: 10 * 1024 * 1024, // 10MB
  MAX_RESULT_CHARS: 100000,
  CACHE_TTL: 15 * 60 * 1000, // 15 min
  CACHE_MAX_SIZE: 50 * 1024 * 1024,
  USER_AGENT: 'minimal-agent-tools/0.1 (+https://github.com/)',

  AI_MODEL: 'claude-3-haiku-20240307', // small + cheap
  AI_MAX_TOKENS: 4096,
  AI_API_URL: 'https://api.anthropic.com/v1/messages',
  AI_API_VERSION: '2023-06-01',
}

/**
 * A short list of common documentation hosts. Loosely "preapproved" so callers
 * that want a permission gate can skip prompting for these. Extend or replace
 * with your own policy.
 */
const PREAPPROVED_DOMAINS = new Set([
  'docs.python.org',
  'developer.mozilla.org',
  'nodejs.org',
  'react.dev',
  'vuejs.org',
  'nextjs.org',
  'www.typescriptlang.org',
  'doc.rust-lang.org',
  'go.dev',
  'kubernetes.io',
  'www.docker.com',
  'docs.aws.amazon.com',
])

class SimpleCache {
  constructor(maxSize, ttl) {
    this.cache = new Map()
    this.maxSize = maxSize
    this.ttl = ttl
  }

  get(key) {
    const item = this.cache.get(key)
    if (!item) return null
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key)
      return null
    }
    return item.value
  }

  set(key, value) {
    if (this.cache.size > 100) {
      const firstKey = this.cache.keys().next().value
      this.cache.delete(firstKey)
    }
    this.cache.set(key, { value, timestamp: Date.now() })
  }
}

const cache = new SimpleCache(CONFIG.CACHE_MAX_SIZE, CONFIG.CACHE_TTL)

/**
 * Pragmatic HTML→Markdown converter. Not a full parser — just enough to make
 * documentation legible to an LLM without leaking raw <div> noise.
 */
function htmlToMarkdown(html) {
  return (
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
      .replace(/<p[^>]*>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
      .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '')
      .replace(/<\/?[uo]l[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function validateUrl(urlString) {
  if (urlString.length > CONFIG.MAX_URL_LENGTH) {
    return { valid: false, error: 'URL too long' }
  }

  let url
  try {
    url = new URL(urlString)
  } catch {
    return { valid: false, error: 'Invalid URL format' }
  }

  if (url.username || url.password) {
    return { valid: false, error: 'URL with credentials not allowed' }
  }

  if (url.hostname.split('.').length < 2) {
    return { valid: false, error: 'Invalid hostname' }
  }

  return { valid: true, url }
}

function isDomainPreapproved(hostname, pathname) {
  for (const domain of PREAPPROVED_DOMAINS) {
    if (domain.includes('/')) {
      const [host, ...pathParts] = domain.split('/')
      const path = '/' + pathParts.join('/')
      if (hostname === host && pathname.startsWith(path)) return true
    } else if (hostname === domain) {
      return true
    }
  }
  return false
}

function fetch(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const protocol = url.protocol === 'https:' ? https : http
    const maxRedirects = options.maxRedirects ?? 5

    const req = protocol.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          'User-Agent': CONFIG.USER_AGENT,
          Accept: 'text/markdown, text/html, */*',
          ...options.headers,
        },
        timeout: options.timeout ?? 30000,
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location
          if (!location) {
            return reject(new Error('Redirect missing Location header'))
          }

          const redirectUrl = new URL(location, urlString).toString()
          const originalHost = url.hostname.replace(/^www\./, '')
          const redirectHost = new URL(redirectUrl).hostname.replace(/^www\./, '')

          // Cross-origin redirects bubble up so the caller can decide whether to follow.
          if (originalHost !== redirectHost) {
            return resolve({
              type: 'redirect',
              originalUrl: urlString,
              redirectUrl,
              statusCode: res.statusCode,
            })
          }

          if (maxRedirects <= 0) {
            return reject(new Error('Too many redirects'))
          }
          return fetch(redirectUrl, { ...options, maxRedirects: maxRedirects - 1 })
            .then(resolve)
            .catch(reject)
        }

        const chunks = []
        let totalLength = 0

        res.on('data', (chunk) => {
          totalLength += chunk.length
          if (totalLength > CONFIG.MAX_CONTENT_LENGTH) {
            req.destroy()
            reject(new Error('Response too large'))
            return
          }
          chunks.push(chunk)
        })

        res.on('end', () => {
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            data: Buffer.concat(chunks),
          })
        })
      },
    )

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy()
        reject(new Error('Request aborted'))
      })
    }

    if (options.body) {
      req.write(options.body)
    }

    req.end()
  })
}

/**
 * Send fetched content + a user prompt to Anthropic's Messages API and return
 * the model's response. Defaults to Haiku to keep cost down.
 */
async function processWithAI(content, prompt, options = {}) {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set. Set it via environment variable or options.apiKey')
  }

  let truncatedContent = content
  if (content.length > CONFIG.MAX_RESULT_CHARS) {
    truncatedContent =
      content.slice(0, CONFIG.MAX_RESULT_CHARS) + '\n\n[Content truncated due to length...]'
  }

  const userMessage = `Here is the content from a web page:

<web_content>
${truncatedContent}
</web_content>

Please process this content according to the following instruction:
${prompt}

Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`

  console.log('[AI] Processing with Claude...')
  const startTime = Date.now()

  const requestBody = JSON.stringify({
    model: options.model || CONFIG.AI_MODEL,
    max_tokens: options.maxTokens || CONFIG.AI_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: userMessage,
      },
    ],
  })

  const response = await fetch(CONFIG.AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': CONFIG.AI_API_VERSION,
    },
    body: requestBody,
    timeout: 60000,
  })

  if (response.status !== 200) {
    const errorBody = response.data.toString('utf-8')
    throw new Error(`API request failed (${response.status}): ${errorBody}`)
  }

  const responseBody = JSON.parse(response.data.toString('utf-8'))

  const textContent = responseBody.content?.find((block) => block.type === 'text')
  if (!textContent?.text) {
    throw new Error('No text response from model')
  }

  const aiDuration = Date.now() - startTime
  console.log(
    `[AI] Completed in ${aiDuration}ms (${responseBody.usage?.input_tokens || '?'} in, ${responseBody.usage?.output_tokens || '?'} out tokens)`,
  )

  return {
    result: textContent.text,
    model: responseBody.model,
    usage: responseBody.usage,
    aiDurationMs: aiDuration,
  }
}

/**
 * Fetch + (optional) AI summarize. Returns the AI summary if `prompt` is given
 * and useAI is not disabled; otherwise returns the raw markdown.
 */
async function webFetch(url, prompt, options = {}) {
  const validation = validateUrl(url)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  // Always upgrade http→https; the LLM rarely cares and we get HSTS-safe by default.
  let targetUrl = url
  if (validation.url.protocol === 'http:') {
    validation.url.protocol = 'https:'
    targetUrl = validation.url.toString()
  }

  const cached = cache.get(targetUrl)
  if (cached) {
    console.log('[Cache hit]', targetUrl)

    if (prompt && options.useAI !== false) {
      const aiResult = await processWithAI(cached.content, prompt, options)
      return {
        ...cached,
        result: aiResult.result,
        aiProcessed: true,
        aiModel: aiResult.model,
        aiUsage: aiResult.usage,
        fromCache: true,
      }
    }

    return {
      ...cached,
      result: cached.content,
      fromCache: true,
    }
  }

  const isPreapproved = isDomainPreapproved(validation.url.hostname, validation.url.pathname)
  console.log(`[Fetching] ${targetUrl} (preapproved: ${isPreapproved})`)

  const startTime = Date.now()
  const response = await fetch(targetUrl, { signal: options.signal })

  if (response.type === 'redirect') {
    const statusText =
      {
        301: 'Moved Permanently',
        302: 'Found',
        307: 'Temporary Redirect',
        308: 'Permanent Redirect',
      }[response.statusCode] || 'Redirect'

    return {
      bytes: 0,
      code: response.statusCode,
      codeText: statusText,
      result: `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To fetch content from the redirected URL, make a new request with:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`,
      durationMs: Date.now() - startTime,
      url: targetUrl,
    }
  }

  const contentType = response.headers['content-type'] || ''
  const rawContent = response.data.toString('utf-8')
  const bytes = Buffer.byteLength(rawContent)

  let content
  if (contentType.includes('text/html')) {
    content = htmlToMarkdown(rawContent)
  } else {
    content = rawContent
  }

  const fetchDuration = Date.now() - startTime

  const cacheEntry = {
    bytes,
    code: response.status,
    codeText: response.statusText,
    content,
    contentType,
    fetchDurationMs: fetchDuration,
    url: targetUrl,
  }
  cache.set(targetUrl, cacheEntry)

  if (prompt && options.useAI !== false) {
    try {
      const aiResult = await processWithAI(content, prompt, options)
      return {
        ...cacheEntry,
        result: aiResult.result,
        aiProcessed: true,
        aiModel: aiResult.model,
        aiUsage: aiResult.usage,
        durationMs: fetchDuration + aiResult.aiDurationMs,
      }
    } catch (aiError) {
      console.error('[AI Error]', aiError.message)
      return {
        ...cacheEntry,
        result: content,
        aiProcessed: false,
        aiError: aiError.message,
        durationMs: fetchDuration,
      }
    }
  }

  return {
    ...cacheEntry,
    result: content,
    durationMs: fetchDuration,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    noAI: args.includes('--no-ai'),
    raw: args.includes('--raw'),
  }

  const positionalArgs = args.filter((arg) => !arg.startsWith('--') && !arg.startsWith('-'))

  if (positionalArgs.length === 0 || flags.help) {
    console.log(`
WebFetch — fetch + HTML→Markdown + optional AI summarization

Usage:
  bun web-fetch.js <url> [prompt] [options]

Arguments:
  url      Page to fetch
  prompt   Optional. If provided, sent to the LLM along with the page content.

Options:
  --no-ai  Skip the AI summarization step (return raw markdown)
  --raw    Alias for --no-ai
  --help   Show this help

Environment:
  ANTHROPIC_API_KEY  Required when summarizing (omit --no-ai)

Examples:
  bun web-fetch.js https://example.com
  bun web-fetch.js https://nodejs.org/api/fs.html "List file read/write APIs"
  bun web-fetch.js https://example.com "any prompt" --no-ai

Pipeline:
  1. Fetch the URL.
  2. Convert HTML to Markdown.
  3. (If a prompt is given) send to Claude Haiku.
  4. Return the model's response (or raw markdown).
`)
    process.exit(0)
  }

  const url = positionalArgs[0]
  const prompt = positionalArgs.slice(1).join(' ') || undefined
  const useAI = !flags.noAI && !flags.raw

  if (prompt && useAI && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required for AI processing.')
    console.error('Set it with: export ANTHROPIC_API_KEY=your-key')
    console.error('Or use --no-ai to skip AI processing.')
    process.exit(1)
  }

  try {
    const result = await webFetch(url, prompt, { useAI })

    console.log('\n' + '='.repeat(60))
    console.log(`URL: ${result.url}`)
    console.log(`Status: ${result.code} ${result.codeText}`)
    console.log(`Size: ${result.bytes} bytes`)
    console.log(`Duration: ${result.durationMs}ms`)
    if (result.fromCache) console.log('(content from cache)')
    if (result.aiProcessed) {
      console.log(`AI Model: ${result.aiModel}`)
      console.log(
        `AI Tokens: ${result.aiUsage?.input_tokens || '?'} in, ${result.aiUsage?.output_tokens || '?'} out`,
      )
    }
    if (result.aiError) {
      console.log(`AI Error: ${result.aiError} (showing raw content)`)
    }
    console.log('='.repeat(60) + '\n')

    console.log(result.result)
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { webFetch, processWithAI, validateUrl, htmlToMarkdown }

if (import.meta.main) {
  main()
}
