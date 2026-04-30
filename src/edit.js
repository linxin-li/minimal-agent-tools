#!/usr/bin/env bun
/**
 * Edit — find-and-replace text in a file.
 *
 * Requires `oldString` to be unique in the file, unless `replaceAll` is set.
 * The uniqueness check is the trick that makes string-replace edits robust against
 * LLM hallucination: if the model didn't see enough context to make the match unique,
 * the edit fails loudly instead of silently corrupting the wrong region.
 */

import fs from 'node:fs'
import path from 'node:path'

const CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
}

/**
 * Count how many times `search` appears in `text`.
 * @param {string} text
 * @param {string} search
 * @returns {number}
 */
function countOccurrences(text, search) {
  if (!search) return 0
  let count = 0
  let pos = 0
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}

/**
 * Locate every occurrence of `search` in `text` with line/column info.
 * @param {string} text
 * @param {string} search
 * @returns {Array<{ line: number, column: number, index: number }>}
 */
function findPositions(text, search) {
  const positions = []
  let pos = 0

  while ((pos = text.indexOf(search, pos)) !== -1) {
    const beforeText = text.substring(0, pos)
    const lines = beforeText.split('\n')
    const line = lines.length
    const column = lines[lines.length - 1].length + 1

    positions.push({ line, column, index: pos })
    pos += search.length
  }

  return positions
}

/**
 * Edit a file by replacing `oldString` with `newString`.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {string} oldString - String to replace. Must be unique unless `replaceAll`.
 * @param {string} newString - Replacement string. Empty string deletes.
 * @param {Object} [options]
 * @param {boolean} [options.replaceAll=false] - Replace all occurrences.
 * @param {boolean} [options.dryRun=false] - Preview only, do not write.
 */
function editFile(filePath, oldString, newString, options = {}) {
  const { replaceAll = false, dryRun = false } = options

  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`)
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const stat = fs.statSync(filePath)
  if (stat.size > CONFIG.MAX_FILE_SIZE) {
    throw new Error(
      `File too large: ${formatBytes(stat.size)} exceeds limit of ${formatBytes(CONFIG.MAX_FILE_SIZE)}`,
    )
  }

  if (!oldString) {
    throw new Error('old_string cannot be empty')
  }

  if (oldString === newString) {
    throw new Error('old_string and new_string must be different')
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  const occurrences = countOccurrences(content, oldString)

  if (occurrences === 0) {
    throw new Error(
      `old_string not found in file: "${oldString.substring(0, 50)}${oldString.length > 50 ? '...' : ''}"`,
    )
  }

  if (occurrences > 1 && !replaceAll) {
    const positions = findPositions(content, oldString)
    const posInfo = positions
      .slice(0, 5)
      .map((p) => `line ${p.line}, col ${p.column}`)
      .join('; ')
    throw new Error(
      `old_string is not unique in file (found ${occurrences} occurrences at: ${posInfo}). ` +
        `Either provide more context to make it unique, or use replace_all to replace all occurrences.`,
    )
  }

  let newContent
  let replacedCount

  if (replaceAll) {
    newContent = content.split(oldString).join(newString)
    replacedCount = occurrences
  } else {
    newContent = content.replace(oldString, newString)
    replacedCount = 1
  }

  const oldLines = content.split('\n').length
  const newLines = newContent.split('\n').length
  const linesDiff = newLines - oldLines

  const positions = findPositions(content, oldString)

  if (!dryRun) {
    fs.writeFileSync(filePath, newContent, 'utf-8')
  }

  return {
    success: true,
    path: filePath,
    replacedCount,
    positions: positions.slice(0, 10),
    linesBefore: oldLines,
    linesAfter: newLines,
    linesDiff,
    dryRun,
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    replaceAll: args.includes('--replace-all') || args.includes('-a'),
    dryRun: args.includes('--dry-run') || args.includes('-n'),
  }

  const filePath = args.find((arg) => !arg.startsWith('-'))

  let oldString = ''
  let newString = ''

  const oldIdx = args.indexOf('--old')
  if (oldIdx !== -1 && args[oldIdx + 1]) {
    oldString = args[oldIdx + 1]
  }

  const newIdx = args.indexOf('--new')
  if (newIdx !== -1 && args[newIdx + 1]) {
    newString = args[newIdx + 1]
  }

  if (!filePath || !oldString || flags.help) {
    console.log(`
Edit — minimal find-and-replace

Usage:
  bun edit.js <file_path> --old <old_string> --new <new_string> [options]

Options:
  --old <text>      String to replace (required)
  --new <text>      Replacement string (required; pass "" to delete)
  --replace-all, -a Replace every occurrence
  --dry-run, -n     Preview only, do not write
  --json            Output JSON
  --help            Show this help

Notes:
  - old_string must be unique in the file unless --replace-all is set.
  - To delete text, use --new "".

Examples:
  bun edit.js /path/to/file.js --old "oldFunc" --new "newFunc"
  bun edit.js /path/to/file.js --old "var" --new "const" -a
  bun edit.js /path/to/file.js --old "foo" --new "bar" -n
`)
    process.exit(0)
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  try {
    const result = editFile(absolutePath, oldString, newString, {
      replaceAll: flags.replaceAll,
      dryRun: flags.dryRun,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      const action = flags.dryRun ? '[DRY RUN] Would replace' : 'Replaced'
      console.log(`${action}: ${result.replacedCount} occurrence(s)`)
      console.log(`File: ${result.path}`)
      console.log(
        `Lines: ${result.linesBefore} → ${result.linesAfter} (${result.linesDiff >= 0 ? '+' : ''}${result.linesDiff})`,
      )

      if (result.positions.length > 0) {
        console.log('Positions:')
        for (const pos of result.positions) {
          console.log(`  - Line ${pos.line}, Column ${pos.column}`)
        }
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { editFile, countOccurrences, findPositions }

if (import.meta.main) {
  main()
}
