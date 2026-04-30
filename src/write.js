#!/usr/bin/env bun
/**
 * Write — minimal file writer with directory creation.
 */

import fs from 'node:fs'
import path from 'node:path'

const CONFIG = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
}

/**
 * Write content to a file.
 *
 * @param {string} filePath - Absolute path to the file.
 * @param {string} content - File content.
 * @param {Object} [options]
 * @param {boolean} [options.createDirs=true] - Create parent dirs if missing.
 * @param {boolean} [options.overwrite=true] - Overwrite an existing file.
 * @returns {{ success: boolean, path: string, size: number, created: boolean, overwritten: boolean }}
 */
function writeFile(filePath, content, options = {}) {
  const { createDirs = true, overwrite = true } = options

  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`)
  }

  const contentSize = Buffer.byteLength(content, 'utf-8')
  if (contentSize > CONFIG.MAX_FILE_SIZE) {
    throw new Error(
      `Content too large: ${formatBytes(contentSize)} exceeds limit of ${formatBytes(CONFIG.MAX_FILE_SIZE)}`,
    )
  }

  const dirPath = path.dirname(filePath)
  const dirExists = fs.existsSync(dirPath)

  if (!dirExists) {
    if (createDirs) {
      fs.mkdirSync(dirPath, { recursive: true })
    } else {
      throw new Error(`Directory does not exist: ${dirPath}`)
    }
  }

  const fileExists = fs.existsSync(filePath)
  if (fileExists && !overwrite) {
    throw new Error(`File already exists: ${filePath}. Use overwrite option to replace.`)
  }

  fs.writeFileSync(filePath, content, 'utf-8')

  return {
    success: true,
    path: filePath,
    size: contentSize,
    created: !fileExists,
    overwritten: fileExists,
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
    stdin: args.includes('--stdin'),
    noDirs: args.includes('--no-create-dirs'),
    noOverwrite: args.includes('--no-overwrite'),
  }

  const filePath = args.find((arg) => !arg.startsWith('-'))

  let content = ''
  const contentIdx = args.indexOf('--content')
  if (contentIdx !== -1 && args[contentIdx + 1]) {
    content = args[contentIdx + 1]
  }

  if (!filePath || flags.help) {
    console.log(`
Write — minimal file writer

Usage:
  bun write.js <file_path> [options]

Options:
  --content <text>    Content to write
  --stdin             Read content from stdin
  --no-create-dirs    Do not auto-create parent directories
  --no-overwrite      Do not overwrite an existing file
  --json              Output JSON
  --help              Show this help

Examples:
  bun write.js /path/to/file.txt --content "Hello World"
  echo "content" | bun write.js /path/to/file.txt --stdin
  bun write.js /path/to/file.txt --content "new" --no-overwrite
`)
    process.exit(0)
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  try {
    if (flags.stdin) {
      content = await readStdin()
    }

    if (!content && !flags.stdin) {
      console.error('Error: No content provided. Use --content or --stdin.')
      process.exit(1)
    }

    const result = writeFile(absolutePath, content, {
      createDirs: !flags.noDirs,
      overwrite: !flags.noOverwrite,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      const action = result.overwritten ? 'Overwrote' : 'Created'
      console.log(`${action}: ${result.path}`)
      console.log(`Size: ${formatBytes(result.size)}`)
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')

    process.stdin.on('readable', () => {
      let chunk
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk
      }
    })

    process.stdin.on('end', () => {
      resolve(data)
    })

    process.stdin.on('error', reject)
  })
}

export { writeFile, formatBytes }

if (import.meta.main) {
  main()
}
