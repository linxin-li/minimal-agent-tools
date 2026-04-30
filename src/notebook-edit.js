#!/usr/bin/env bun
/**
 * NotebookEdit — edit a single cell of a Jupyter notebook (.ipynb).
 * Supports replace / insert / delete.
 */

import fs from 'node:fs'
import path from 'node:path'

const CONFIG = {
  SUPPORTED_EXTENSIONS: ['.ipynb'],
  DEFAULT_CELL_TYPE: 'code',
}

function readNotebook(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const ext = path.extname(filePath).toLowerCase()
  if (!CONFIG.SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Not a Jupyter notebook: ${filePath}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')

  try {
    return JSON.parse(content)
  } catch (error) {
    throw new Error(`Invalid notebook JSON: ${error.message}`)
  }
}

function writeNotebook(filePath, notebook) {
  const content = JSON.stringify(notebook, null, 1)
  fs.writeFileSync(filePath, content, 'utf-8')
}

/**
 * Build a fresh cell. Source is split into the per-line array shape Jupyter expects.
 */
function createCell(cellType, source) {
  const sourceLines = source
    .split('\n')
    .map((line, idx, arr) => (idx === arr.length - 1 ? line : line + '\n'))

  const cell = {
    cell_type: cellType,
    metadata: {},
    source: sourceLines,
  }

  if (cellType === 'code') {
    cell.execution_count = null
    cell.outputs = []
  }

  return cell
}

function findCellIndexById(cells, cellId) {
  return cells.findIndex((cell) => cell.id === cellId || cell.metadata?.id === cellId)
}

/**
 * Edit a notebook.
 *
 * @param {string} filePath - Absolute path to the .ipynb file.
 * @param {Object} options
 * @param {string} [options.cellId] - Target cell by id.
 * @param {number} [options.cellNumber] - Target cell by 0-based index.
 * @param {'replace'|'insert'|'delete'} [options.editMode='replace']
 * @param {'code'|'markdown'} [options.cellType] - Required for `insert`.
 * @param {string} [options.newSource]
 * @param {boolean} [options.dryRun=false]
 */
function editNotebook(filePath, options = {}) {
  const {
    cellId,
    cellNumber,
    editMode = 'replace',
    cellType,
    newSource = '',
    dryRun = false,
  } = options

  if (!path.isAbsolute(filePath)) {
    throw new Error(`Path must be absolute: ${filePath}`)
  }

  const notebook = readNotebook(filePath)

  if (!notebook.cells || !Array.isArray(notebook.cells)) {
    throw new Error('Invalid notebook structure: missing cells array')
  }

  const totalCells = notebook.cells.length

  let targetIndex

  if (cellId !== undefined) {
    targetIndex = findCellIndexById(notebook.cells, cellId)
    if (targetIndex === -1 && editMode !== 'insert') {
      throw new Error(`Cell not found with ID: ${cellId}`)
    }
  } else if (cellNumber !== undefined) {
    targetIndex = cellNumber
  } else {
    throw new Error('Must specify either cellId or cellNumber')
  }

  if (editMode !== 'insert') {
    if (targetIndex < 0 || targetIndex >= totalCells) {
      throw new Error(`Cell index out of range: ${targetIndex} (total cells: ${totalCells})`)
    }
  }

  const result = {
    success: true,
    path: filePath,
    editMode,
    targetIndex,
    totalCellsBefore: totalCells,
    dryRun,
  }

  switch (editMode) {
    case 'replace': {
      const existingCell = notebook.cells[targetIndex]
      const newCellType = cellType || existingCell.cell_type
      const newCell = createCell(newCellType, newSource)

      // Preserve original IDs so external references don't break.
      if (existingCell.id) newCell.id = existingCell.id
      if (existingCell.metadata?.id) {
        newCell.metadata.id = existingCell.metadata.id
      }

      result.oldCellType = existingCell.cell_type
      result.newCellType = newCellType
      result.oldSource = Array.isArray(existingCell.source)
        ? existingCell.source.join('')
        : existingCell.source

      if (!dryRun) {
        notebook.cells[targetIndex] = newCell
      }
      break
    }

    case 'insert': {
      if (!cellType) {
        throw new Error('cellType is required for insert mode')
      }

      const newCell = createCell(cellType, newSource)
      newCell.id = `cell-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      result.newCellType = cellType
      result.insertAfterIndex = targetIndex

      if (!dryRun) {
        const insertIndex =
          cellId !== undefined ? (targetIndex === -1 ? 0 : targetIndex + 1) : targetIndex
        notebook.cells.splice(insertIndex, 0, newCell)
        result.newIndex = insertIndex
      }
      break
    }

    case 'delete': {
      const deletedCell = notebook.cells[targetIndex]
      result.deletedCellType = deletedCell.cell_type
      result.deletedSource = Array.isArray(deletedCell.source)
        ? deletedCell.source.join('')
        : deletedCell.source

      if (!dryRun) {
        notebook.cells.splice(targetIndex, 1)
      }
      break
    }

    default:
      throw new Error(`Invalid edit mode: ${editMode}`)
  }

  result.totalCellsAfter = dryRun ? totalCells : notebook.cells.length

  if (!dryRun) {
    writeNotebook(filePath, notebook)
  }

  return result
}

/** Return a one-line summary per cell (useful for the LLM to pick a target). */
function listCells(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  const notebook = readNotebook(absolutePath)

  return notebook.cells.map((cell, idx) => {
    const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source || ''

    return {
      index: idx,
      id: cell.id || cell.metadata?.id || null,
      type: cell.cell_type,
      lines: source.split('\n').length,
      preview: source.substring(0, 100) + (source.length > 100 ? '...' : ''),
    }
  })
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run') || args.includes('-n'),
    list: args.includes('--list') || args.includes('-l'),
  }

  const filePath = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (idx > 0 && ['--cell', '--cell-id', '--mode', '--type', '--source'].includes(args[idx - 1]))
      return false
    return true
  })

  let cellNumber
  let cellId
  let editMode = 'replace'
  let cellType
  let newSource = ''

  const cellIdx = args.indexOf('--cell')
  if (cellIdx !== -1) cellNumber = parseInt(args[cellIdx + 1], 10)

  const cellIdIdx = args.indexOf('--cell-id')
  if (cellIdIdx !== -1) cellId = args[cellIdIdx + 1]

  const modeIdx = args.indexOf('--mode')
  if (modeIdx !== -1) editMode = args[modeIdx + 1]

  const typeIdx = args.indexOf('--type')
  if (typeIdx !== -1) cellType = args[typeIdx + 1]

  const sourceIdx = args.indexOf('--source')
  if (sourceIdx !== -1) newSource = args[sourceIdx + 1]

  if (!filePath || flags.help) {
    console.log(`
NotebookEdit — minimal Jupyter notebook editor

Usage:
  bun notebook-edit.js <notebook_path> [options]

Options:
  --cell <n>       Cell index (0-based)
  --cell-id <id>   Cell id
  --mode <mode>    Edit mode (replace | insert | delete)
  --type <type>    Cell type (code | markdown)
  --source <text>  New cell content
  --list, -l       List all cells
  --dry-run, -n    Preview only
  --json           Output JSON
  --help           Show this help

Examples:
  bun notebook-edit.js /path/to/notebook.ipynb --list
  bun notebook-edit.js /path/to/notebook.ipynb --cell 0 --source "print('hello')"
  bun notebook-edit.js /path/to/notebook.ipynb --cell 1 --mode insert --type code --source "x = 1"
  bun notebook-edit.js /path/to/notebook.ipynb --cell 2 --mode delete
  bun notebook-edit.js /path/to/notebook.ipynb --cell 0 --source "new" -n
`)
    process.exit(0)
  }

  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath)

  try {
    if (flags.list) {
      const cells = listCells(absolutePath)

      if (flags.json) {
        console.log(JSON.stringify(cells, null, 2))
      } else {
        console.log(`Notebook: ${absolutePath}`)
        console.log(`Total cells: ${cells.length}`)
        console.log('---')

        for (const cell of cells) {
          console.log(`[${cell.index}] ${cell.type}${cell.id ? ` (id: ${cell.id})` : ''}`)
          console.log(`    ${cell.preview.split('\n')[0]}`)
        }
      }
      return
    }

    if (cellNumber === undefined && !cellId) {
      console.error('Error: Must specify --cell or --cell-id')
      process.exit(1)
    }

    const result = editNotebook(absolutePath, {
      cellNumber,
      cellId,
      editMode,
      cellType,
      newSource,
      dryRun: flags.dryRun,
    })

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      const action = flags.dryRun ? '[DRY RUN] Would' : 'Successfully'
      console.log(`${action} ${editMode} cell at index ${result.targetIndex}`)
      console.log(`File: ${result.path}`)
      console.log(`Cells: ${result.totalCellsBefore} → ${result.totalCellsAfter}`)

      if (editMode === 'replace') {
        console.log(`Type: ${result.oldCellType} → ${result.newCellType}`)
      } else if (editMode === 'insert') {
        console.log(`New cell type: ${result.newCellType}`)
      } else if (editMode === 'delete') {
        console.log(`Deleted: ${result.deletedCellType} cell`)
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export { editNotebook, readNotebook, writeNotebook, listCells, createCell }

if (import.meta.main) {
  main()
}
