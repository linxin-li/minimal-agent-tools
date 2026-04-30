#!/usr/bin/env bun
/**
 * Glob — file pattern matching, results sorted by mtime (newest first).
 */

import fs from 'node:fs'
import path from 'node:path'

const CONFIG = {
  MAX_RESULTS: 1000,
  DEFAULT_IGNORE: [
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '__pycache__',
    '.DS_Store',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.cache',
  ],
}

/**
 * Convert a glob pattern to a regular expression.
 * Supports `*`, `**`, `?`. Brace expansion (`{a,b}`) is not implemented.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')

  return new RegExp('^' + regex + '$')
}

/**
 * Recursively collect every file under `dir`, skipping ignored directories.
 *
 * @param {string} dir
 * @param {Object} [options]
 * @param {string[]} [options.ignore]
 * @param {number} [options.maxDepth]
 * @returns {Array<{ path: string, mtime: Date }>}
 */
function getAllFiles(dir, options = {}) {
  const { ignore = CONFIG.DEFAULT_IGNORE, maxDepth = Infinity, currentDepth = 0 } = options
  const results = []

  if (currentDepth > maxDepth) return results

  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (ignore.some((ig) => entry.name === ig || fullPath.includes(`/${ig}/`))) {
      continue
    }

    if (entry.isDirectory()) {
      results.push(
        ...getAllFiles(fullPath, {
          ...options,
          currentDepth: currentDepth + 1,
        }),
      )
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath)
        results.push({
          path: fullPath,
          mtime: stat.mtime,
        })
      } catch {
        // skip unreadable files
      }
    }
  }

  return results
}

/**
 * Match files against a glob pattern.
 *
 * @param {string} pattern - e.g. "**\/*.js" or "src/**\/*.ts".
 * @param {Object} [options]
 * @param {string} [options.path] - Search root (default: cwd).
 * @param {string[]} [options.ignore]
 * @param {number} [options.limit]
 * @returns {{ files: string[], count: number, totalMatches: number, truncated: boolean, pattern: string, searchPath: string }}
 */
function glob(pattern, options = {}) {
  const {
    path: searchPath = process.cwd(),
    ignore = CONFIG.DEFAULT_IGNORE,
    limit = CONFIG.MAX_RESULTS,
  } = options

  const absolutePath = path.isAbsolute(searchPath)
    ? searchPath
    : path.resolve(process.cwd(), searchPath)

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Directory not found: ${absolutePath}`)
  }

  const stat = fs.statSync(absolutePath)
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absolutePath}`)
  }

  const cleanPattern = pattern.startsWith('/') ? pattern.slice(1) : pattern

  let baseDir = absolutePath
  let filePattern = cleanPattern

  if (path.isAbsolute(pattern)) {
    const patternDir = path.dirname(pattern)
    const patternBase = path.basename(pattern)
    if (fs.existsSync(patternDir)) {
      baseDir = patternDir
      filePattern = patternBase
    }
  }

  const allFiles = getAllFiles(baseDir, { ignore })
  const regex = globToRegex(filePattern)

  const matchedFiles = allFiles.filter((file) => {
    const relativePath = path.relative(baseDir, file.path)
    return regex.test(relativePath)
  })

  // Sort newest-first. This matters: when an LLM glob-matches and reads the top N,
  // recent edits are usually what it wants.
  matchedFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  const truncated = matchedFiles.length > limit
  const limitedFiles = matchedFiles.slice(0, limit)

  return {
    files: limitedFiles.map((f) => f.path),
    count: limitedFiles.length,
    totalMatches: matchedFiles.length,
    truncated,
    pattern,
    searchPath: absolutePath,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    relative: args.includes('--relative'),
  }

  let searchPath = process.cwd()
  let limit = CONFIG.MAX_RESULTS

  const pathIdx = args.indexOf('--path')
  if (pathIdx !== -1 && args[pathIdx + 1]) {
    searchPath = args[pathIdx + 1]
  }

  const limitIdx = args.indexOf('--limit')
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10)
  }

  const pattern = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (idx > 0 && ['--path', '--limit'].includes(args[idx - 1])) return false
    return true
  })

  if (!pattern || flags.help) {
    console.log(`
Glob — minimal file pattern matcher

Usage:
  bun glob.js <pattern> [options]

Options:
  --path <dir>   Search directory (default: cwd)
  --limit <n>    Max results (default: ${CONFIG.MAX_RESULTS})
  --relative     Output relative paths
  --json         Output JSON
  --help         Show this help

Pattern syntax:
  *      Any sequence of characters within a path segment
  **     Any path (across directories)
  ?      Any single character
  {a,b}  Brace expansion (NOT implemented)

Default ignored:
  ${CONFIG.DEFAULT_IGNORE.join(', ')}

Examples:
  bun glob.js "**/*.js"
  bun glob.js "**/*.ts" --path /path/to/project
  bun glob.js "**/*" --limit 50
`)
    process.exit(0)
  }

  try {
    const result = glob(pattern, { path: searchPath, limit })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Pattern: ${result.pattern}`)
      console.log(`Search path: ${result.searchPath}`)
      console.log(
        `Found: ${result.count} files${result.truncated ? ` (showing first ${limit} of ${result.totalMatches})` : ''}`,
      )
      console.log('---')

      for (const file of result.files) {
        const displayPath = flags.relative ? path.relative(result.searchPath, file) : file
        console.log(displayPath)
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { glob, globToRegex, getAllFiles }

if (import.meta.main) {
  main()
}
