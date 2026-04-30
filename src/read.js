#!/usr/bin/env bun
/**
 * Read — minimal file reader with offset/limit pagination and `cat -n` style line numbers.
 *
 * Handles text, images (base64), PDF (metadata only), and Jupyter notebooks.
 */

import fs from 'node:fs'
import path from 'node:path'

const CONFIG = {
  DEFAULT_LIMIT: 2000,
  MAX_LINE_LENGTH: 2000,
  SUPPORTED_IMAGES: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'],
  SUPPORTED_DOCS: ['.pdf'],
  SUPPORTED_NOTEBOOKS: ['.ipynb'],
}

/**
 * Read a file and return its content.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {Object} [options]
 * @param {number} [options.offset=1] - 1-based starting line number.
 * @param {number} [options.limit=2000] - Number of lines to read.
 * @returns {{ content: string, lineCount?: number, totalLines?: number, truncated?: boolean, startLine?: number, endLine?: number, type?: string }}
 */
function readFile(filePath, options = {}) {
  const { offset = 1, limit = CONFIG.DEFAULT_LIMIT } = options

  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`)
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) {
    throw new Error(`Cannot read directory: ${filePath}. Use a shell tool instead.`)
  }

  const ext = path.extname(filePath).toLowerCase()

  if (CONFIG.SUPPORTED_IMAGES.includes(ext)) {
    return readImageFile(filePath, stat)
  }

  if (CONFIG.SUPPORTED_DOCS.includes(ext)) {
    return readPdfFile(filePath, stat)
  }

  if (CONFIG.SUPPORTED_NOTEBOOKS.includes(ext)) {
    return readNotebookFile(filePath)
  }

  return readTextFile(filePath, offset, limit)
}

function readTextFile(filePath, offset, limit) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const totalLines = lines.length

  const startLine = Math.max(1, offset)
  const endLine = Math.min(totalLines, startLine + limit - 1)
  const selectedLines = lines.slice(startLine - 1, endLine)

  // `cat -n` style output. Long lines are truncated so a single line cannot blow past
  // the model's context window.
  const formattedLines = selectedLines.map((line, idx) => {
    const lineNum = startLine + idx
    const truncatedLine =
      line.length > CONFIG.MAX_LINE_LENGTH
        ? line.substring(0, CONFIG.MAX_LINE_LENGTH) + '...[truncated]'
        : line

    const lineNumStr = String(lineNum).padStart(6, ' ')
    return `${lineNumStr}\t${truncatedLine}`
  })

  return {
    content: formattedLines.join('\n'),
    lineCount: selectedLines.length,
    totalLines,
    truncated: endLine < totalLines,
    startLine,
    endLine,
  }
}

/** Read an image file and return its base64 representation. */
function readImageFile(filePath, stat) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
  }

  const buffer = fs.readFileSync(filePath)
  const base64 = buffer.toString('base64')
  const mimeType = mimeTypes[ext] || 'application/octet-stream'

  return {
    type: 'image',
    mimeType,
    base64,
    size: stat.size,
    content: `[Image file: ${path.basename(filePath)}, ${formatBytes(stat.size)}, ${mimeType}]`,
  }
}

/**
 * Read a PDF file. This minimal version returns only metadata.
 * For full text extraction, plug in `pdf-parse` or a similar library.
 */
function readPdfFile(filePath, stat) {
  return {
    type: 'pdf',
    size: stat.size,
    content:
      `[PDF file: ${path.basename(filePath)}, ${formatBytes(stat.size)}]\n` +
      `Note: Full PDF parsing requires an additional library (e.g. pdf-parse).`,
  }
}

/** Read a Jupyter notebook and flatten cells into a textual representation. */
function readNotebookFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8')
  const notebook = JSON.parse(content)

  const cells = notebook.cells || []
  const output = []

  cells.forEach((cell, idx) => {
    const cellType = cell.cell_type || 'unknown'
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source

    output.push(`--- Cell ${idx + 1} [${cellType}] ---`)
    output.push(source)

    if (cell.outputs && cell.outputs.length > 0) {
      output.push('\n[Output]:')
      cell.outputs.forEach((out) => {
        if (out.text) {
          output.push(Array.isArray(out.text) ? out.text.join('') : out.text)
        } else if (out.data) {
          if (out.data['text/plain']) {
            const text = out.data['text/plain']
            output.push(Array.isArray(text) ? text.join('') : text)
          } else {
            output.push(`[${Object.keys(out.data).join(', ')}]`)
          }
        }
      })
    }
    output.push('')
  })

  return {
    type: 'notebook',
    cellCount: cells.length,
    content: output.join('\n'),
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
  }

  let offset = 1
  let limit = CONFIG.DEFAULT_LIMIT

  const offsetIdx = args.indexOf('--offset')
  if (offsetIdx !== -1 && args[offsetIdx + 1]) {
    offset = parseInt(args[offsetIdx + 1], 10)
  }

  const limitIdx = args.indexOf('--limit')
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10)
  }

  const filePath = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (idx > 0 && ['--offset', '--limit'].includes(args[idx - 1])) return false
    return true
  })

  if (!filePath || flags.help) {
    console.log(`
Read — minimal file reader

Usage:
  bun read.js <file_path> [options]

Options:
  --offset <n>  Start at line n (default: 1)
  --limit <n>   Read n lines (default: ${CONFIG.DEFAULT_LIMIT})
  --json        Output JSON
  --help        Show this help

Supported file types:
  - Text:    line-numbered output (cat -n style)
  - Images:  ${CONFIG.SUPPORTED_IMAGES.join(', ')}
  - PDF:     ${CONFIG.SUPPORTED_DOCS.join(', ')} (metadata only)
  - Jupyter: ${CONFIG.SUPPORTED_NOTEBOOKS.join(', ')}

Examples:
  bun read.js /path/to/file.js
  bun read.js /path/to/file.js --offset 100 --limit 100
  bun read.js /path/to/file.js --json
`)
    process.exit(0)
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  try {
    const result = readFile(absolutePath, { offset, limit })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      if (result.totalLines) {
        console.log(`File: ${absolutePath}`)
        console.log(`Lines: ${result.startLine}-${result.endLine} of ${result.totalLines}`)
        if (result.truncated) {
          console.log(`(More lines available, use --offset to continue)`)
        }
        console.log('---')
      }
      console.log(result.content)
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { readFile, formatBytes }

if (import.meta.main) {
  main()
}
