#!/usr/bin/env bun
/**
 * Grep — regex search across files.
 *
 * Three output modes (matching what LLM tool callers typically want):
 *   - files_with_matches (default): list of files that contain a match
 *   - content: matched lines with optional context
 *   - count: per-file match count
 */

import fs from 'node:fs'
import path from 'node:path'

const CONFIG = {
  MAX_FILE_SIZE: 1024 * 1024, // 1MB
  MAX_RESULTS: 1000,
  MAX_LINE_LENGTH: 500,
  DEFAULT_CONTEXT: 0,
  BINARY_EXTENSIONS: [
    '.exe', '.dll', '.so', '.dylib', '.bin', '.obj',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
    '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
  ],
  DEFAULT_IGNORE: [
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '__pycache__',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.cache',
  ],
  FILE_TYPE_EXTENSIONS: {
    js: ['.js', '.mjs', '.cjs', '.jsx'],
    ts: ['.ts', '.tsx', '.mts', '.cts'],
    py: ['.py', '.pyw', '.pyi'],
    java: ['.java'],
    c: ['.c', '.h'],
    cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    go: ['.go'],
    rust: ['.rs'],
    rb: ['.rb'],
    php: ['.php'],
    css: ['.css', '.scss', '.sass', '.less'],
    html: ['.html', '.htm', '.xhtml'],
    json: ['.json'],
    yaml: ['.yaml', '.yml'],
    md: ['.md', '.markdown'],
    sql: ['.sql'],
    sh: ['.sh', '.bash', '.zsh'],
  },
}

function getAllFiles(dir, options = {}) {
  const { ignore = CONFIG.DEFAULT_IGNORE, extensions = null } = options
  const results = []

  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (ignore.some((ig) => entry.name === ig)) {
      continue
    }

    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath, options))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()

      if (CONFIG.BINARY_EXTENSIONS.includes(ext)) {
        continue
      }

      if (extensions && !extensions.includes(ext)) {
        continue
      }

      results.push(fullPath)
    }
  }

  return results
}

/**
 * Heuristic binary check: read the first 512 bytes and look for a NULL byte.
 * Cheap and good enough for source-tree search.
 */
function isBinary(filePath) {
  try {
    const buffer = Buffer.alloc(512)
    const fd = fs.openSync(filePath, 'r')
    const bytesRead = fs.readSync(fd, buffer, 0, 512, 0)
    fs.closeSync(fd)

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Search a single file with `regex` and return matches with optional context.
 * @returns {Array<{ line: number, content: string, match: string, before?: any[], after?: any[] }>}
 */
function searchFile(filePath, regex, options = {}) {
  const { contextBefore = 0, contextAfter = 0, maxLineLength = CONFIG.MAX_LINE_LENGTH } = options
  const matches = []

  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return matches
  }

  if (stat.size > CONFIG.MAX_FILE_SIZE) {
    return matches
  }

  let content
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return matches
  }

  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(regex)

    if (match) {
      const result = {
        line: i + 1,
        content: line.length > maxLineLength ? line.substring(0, maxLineLength) + '...' : line,
        match: match[0],
      }

      if (contextBefore > 0 || contextAfter > 0) {
        const beforeLines = []
        const afterLines = []

        for (let j = Math.max(0, i - contextBefore); j < i; j++) {
          beforeLines.push({ line: j + 1, content: lines[j] })
        }

        for (let j = i + 1; j <= Math.min(lines.length - 1, i + contextAfter); j++) {
          afterLines.push({ line: j + 1, content: lines[j] })
        }

        result.before = beforeLines
        result.after = afterLines
      }

      matches.push(result)
    }
  }

  return matches
}

/**
 * Run a regex search across files.
 *
 * @param {string} pattern - Regex pattern.
 * @param {Object} [options]
 * @param {string} [options.path] - Root path (default: cwd).
 * @param {string} [options.glob] - File glob filter (e.g. "*.js").
 * @param {string} [options.type] - File type alias ("js", "ts", "py", ...).
 * @param {'files_with_matches'|'content'|'count'} [options.output_mode]
 * @param {boolean} [options.caseInsensitive]
 * @param {number} [options.contextBefore]
 * @param {number} [options.contextAfter]
 * @param {number} [options.context]
 * @param {number} [options.headLimit]
 * @param {number} [options.offset]
 * @param {boolean} [options.multiline]
 * @param {boolean} [options.showLineNumbers]
 */
function grep(pattern, options = {}) {
  const {
    path: searchPath = process.cwd(),
    glob: globPattern = null,
    type = null,
    output_mode = 'files_with_matches',
    caseInsensitive = false,
    contextBefore = 0,
    contextAfter = 0,
    context = 0,
    headLimit = 0,
    offset = 0,
    multiline = false,
    showLineNumbers = true,
  } = options

  const absolutePath = path.isAbsolute(searchPath)
    ? searchPath
    : path.resolve(process.cwd(), searchPath)

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Path not found: ${absolutePath}`)
  }

  let flags = 'g'
  if (caseInsensitive) flags += 'i'
  if (multiline) flags += 'ms'

  let regex
  try {
    regex = new RegExp(pattern, flags)
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error.message}`)
  }

  let extensions = null
  if (type && CONFIG.FILE_TYPE_EXTENSIONS[type]) {
    extensions = CONFIG.FILE_TYPE_EXTENSIONS[type]
  }
  if (globPattern) {
    const extMatch = globPattern.match(/\*\.(\w+)$/)
    if (extMatch) {
      extensions = ['.' + extMatch[1]]
    }
  }

  const stat = fs.statSync(absolutePath)
  let files

  if (stat.isFile()) {
    files = [absolutePath]
  } else {
    files = getAllFiles(absolutePath, { extensions })
  }

  const ctxBefore = context || contextBefore
  const ctxAfter = context || contextAfter

  const results = []
  let totalMatches = 0

  for (const file of files) {
    if (isBinary(file)) continue

    const matches = searchFile(file, regex, {
      contextBefore: ctxBefore,
      contextAfter: ctxAfter,
    })

    if (matches.length > 0) {
      totalMatches += matches.length
      results.push({
        file,
        matches,
        count: matches.length,
      })
    }
  }

  let finalResults = results
  if (offset > 0) {
    finalResults = finalResults.slice(offset)
  }
  if (headLimit > 0) {
    finalResults = finalResults.slice(0, headLimit)
  }

  let output
  switch (output_mode) {
    case 'content':
      output = finalResults.map((r) => ({
        file: r.file,
        matches: showLineNumbers ? r.matches : r.matches.map((m) => ({ ...m, line: undefined })),
      }))
      break
    case 'count':
      output = finalResults.map((r) => ({
        file: r.file,
        count: r.count,
      }))
      break
    case 'files_with_matches':
    default:
      output = finalResults.map((r) => r.file)
      break
  }

  return {
    pattern,
    output_mode,
    results: output,
    totalFiles: results.length,
    totalMatches,
    searchPath: absolutePath,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    caseInsensitive: args.includes('-i'),
    multiline: args.includes('--multiline'),
    showLineNumbers: !args.includes('--no-line-numbers'),
  }

  let searchPath = process.cwd()
  let outputMode = 'files_with_matches'
  let globPattern = null
  let fileType = null
  let contextBefore = 0
  let contextAfter = 0
  let context = 0
  let headLimit = 0
  let offset = 0

  const pathIdx = args.indexOf('--path')
  if (pathIdx !== -1) searchPath = args[pathIdx + 1]

  const modeIdx = args.indexOf('--mode')
  if (modeIdx !== -1) outputMode = args[modeIdx + 1]

  const globIdx = args.indexOf('--glob')
  if (globIdx !== -1) globPattern = args[globIdx + 1]

  const typeIdx = args.indexOf('--type')
  if (typeIdx !== -1) fileType = args[typeIdx + 1]

  const beforeIdx = args.indexOf('-B')
  if (beforeIdx !== -1) contextBefore = parseInt(args[beforeIdx + 1], 10)

  const afterIdx = args.indexOf('-A')
  if (afterIdx !== -1) contextAfter = parseInt(args[afterIdx + 1], 10)

  const ctxIdx = args.indexOf('-C')
  if (ctxIdx !== -1) context = parseInt(args[ctxIdx + 1], 10)

  const limitIdx = args.indexOf('--limit')
  if (limitIdx !== -1) headLimit = parseInt(args[limitIdx + 1], 10)

  const offsetIdx = args.indexOf('--offset')
  if (offsetIdx !== -1) offset = parseInt(args[offsetIdx + 1], 10)

  const pattern = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (
      idx > 0 &&
      ['--path', '--mode', '--glob', '--type', '-B', '-A', '-C', '--limit', '--offset'].includes(
        args[idx - 1],
      )
    )
      return false
    return true
  })

  if (!pattern || flags.help) {
    console.log(`
Grep — minimal regex search

Usage:
  bun grep.js <pattern> [options]

Options:
  --path <dir>       Search path (default: cwd)
  --mode <mode>      Output mode:
                     - files_with_matches (default): list matching files
                     - content: matched lines (with optional context)
                     - count: per-file match count
  --glob <pattern>   File-name glob filter (e.g. "*.js")
  --type <type>      File type (${Object.keys(CONFIG.FILE_TYPE_EXTENSIONS).join(', ')})
  -i                 Case-insensitive
  -B <n>             Show n lines before each match
  -A <n>             Show n lines after each match
  -C <n>             Shorthand for -B n -A n
  --multiline        Multiline regex flags (m, s)
  --limit <n>        Limit number of file results
  --offset <n>       Skip first n file results
  --json             Output JSON
  --help             Show this help

Examples:
  bun grep.js "function\\s+\\w+" --type js
  bun grep.js "TODO" --mode content -C 2
  bun grep.js "error" -i --type py
`)
    process.exit(0)
  }

  try {
    const result = grep(pattern, {
      path: searchPath,
      output_mode: outputMode,
      glob: globPattern,
      type: fileType,
      caseInsensitive: flags.caseInsensitive,
      contextBefore,
      contextAfter,
      context,
      headLimit,
      offset,
      multiline: flags.multiline,
      showLineNumbers: flags.showLineNumbers,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Pattern: ${result.pattern}`)
      console.log(`Search path: ${result.searchPath}`)
      console.log(`Found: ${result.totalMatches} matches in ${result.totalFiles} files`)
      console.log('---')

      if (outputMode === 'files_with_matches') {
        for (const file of result.results) {
          console.log(file)
        }
      } else if (outputMode === 'content') {
        for (const item of result.results) {
          console.log(`\n${item.file}:`)
          for (const match of item.matches) {
            if (match.before) {
              for (const ctx of match.before) {
                console.log(`  ${ctx.line}-  ${ctx.content}`)
              }
            }
            console.log(`  ${match.line}:  ${match.content}`)
            if (match.after) {
              for (const ctx of match.after) {
                console.log(`  ${ctx.line}+  ${ctx.content}`)
              }
            }
          }
        }
      } else if (outputMode === 'count') {
        for (const item of result.results) {
          console.log(`${item.file}: ${item.count}`)
        }
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { grep, searchFile, getAllFiles }

if (import.meta.main) {
  main()
}
