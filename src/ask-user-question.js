#!/usr/bin/env bun
/**
 * AskUserQuestion — present 1-4 multiple-choice questions to the user.
 *
 * Each question has 2-4 options plus an automatic "Other" escape hatch for
 * free-text input. Supports single- and multi-select. The validation rules
 * (max 4 questions, max 4 options, header ≤ 12 chars) keep the schema small
 * enough that the LLM produces well-formed input reliably.
 */

import readline from 'node:readline'

const CONFIG = {
  MAX_QUESTIONS: 4,
  MAX_OPTIONS: 4,
  MIN_OPTIONS: 2,
}

function validateQuestions(questions) {
  if (!Array.isArray(questions)) {
    return { valid: false, error: 'questions must be an array' }
  }

  if (questions.length < 1 || questions.length > CONFIG.MAX_QUESTIONS) {
    return { valid: false, error: `questions must have 1-${CONFIG.MAX_QUESTIONS} items` }
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]

    if (!q.question || typeof q.question !== 'string') {
      return { valid: false, error: `Question ${i + 1}: missing question text` }
    }

    if (!q.header || typeof q.header !== 'string') {
      return { valid: false, error: `Question ${i + 1}: missing header` }
    }

    if (q.header.length > 12) {
      return { valid: false, error: `Question ${i + 1}: header too long (max 12 chars)` }
    }

    if (!Array.isArray(q.options)) {
      return { valid: false, error: `Question ${i + 1}: options must be an array` }
    }

    if (q.options.length < CONFIG.MIN_OPTIONS || q.options.length > CONFIG.MAX_OPTIONS) {
      return {
        valid: false,
        error: `Question ${i + 1}: must have ${CONFIG.MIN_OPTIONS}-${CONFIG.MAX_OPTIONS} options`,
      }
    }

    for (let j = 0; j < q.options.length; j++) {
      const opt = q.options[j]
      if (!opt.label || typeof opt.label !== 'string') {
        return { valid: false, error: `Question ${i + 1}, Option ${j + 1}: missing label` }
      }
      if (!opt.description || typeof opt.description !== 'string') {
        return { valid: false, error: `Question ${i + 1}, Option ${j + 1}: missing description` }
      }
    }
  }

  return { valid: true }
}

function formatQuestion(question, index) {
  const lines = []

  lines.push(`\n[${question.header}] Question ${index + 1}:`)
  lines.push(question.question)
  lines.push('')

  question.options.forEach((opt, i) => {
    lines.push(`  ${i + 1}. ${opt.label}`)
    if (opt.description) {
      lines.push(`     ${opt.description}`)
    }
  })

  // Always offer an "Other" escape hatch for free text input.
  lines.push(`  ${question.options.length + 1}. Other (custom input)`)

  if (question.multiSelect) {
    lines.push('\n(Multiple selections allowed - enter numbers separated by commas, e.g., "1,3")')
  }

  return lines.join('\n')
}

function readInput(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function parseSelection(input, question) {
  const optionCount = question.options.length
  const otherIndex = optionCount + 1

  if (question.multiSelect) {
    const selections = input.split(',').map((s) => parseInt(s.trim(), 10))
    const validSelections = []
    let hasOther = false

    for (const sel of selections) {
      if (isNaN(sel) || sel < 1 || sel > otherIndex) {
        return { valid: false, error: `Invalid selection: ${sel}` }
      }
      if (sel === otherIndex) {
        hasOther = true
      } else {
        validSelections.push(sel - 1)
      }
    }

    return {
      valid: true,
      selections: validSelections,
      hasOther,
      selectedLabels: validSelections.map((i) => question.options[i].label),
    }
  } else {
    const sel = parseInt(input, 10)

    if (isNaN(sel) || sel < 1 || sel > otherIndex) {
      return { valid: false, error: `Please enter a number between 1 and ${otherIndex}` }
    }

    if (sel === otherIndex) {
      return { valid: true, selection: null, hasOther: true }
    }

    return {
      valid: true,
      selection: sel - 1,
      hasOther: false,
      selectedLabel: question.options[sel - 1].label,
    }
  }
}

/**
 * Interactive prompt loop.
 * @param {Array} questions
 * @returns {Promise<{ success: boolean, answers: Record<string, any> }>}
 */
async function askUserQuestions(questions) {
  const validation = validateQuestions(questions)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  const answers = {}

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i]
    console.log(formatQuestion(question, i))

    let result
    let validAnswer = false

    while (!validAnswer) {
      const input = await readInput('\nYour choice: ')

      result = parseSelection(input, question)

      if (!result.valid) {
        console.log(`Error: ${result.error}`)
        continue
      }

      if (result.hasOther) {
        const customInput = await readInput('Enter your custom response: ')
        result.customInput = customInput
      }

      validAnswer = true
    }

    const key = question.header.toLowerCase().replace(/\s+/g, '_')

    if (question.multiSelect) {
      answers[key] = {
        selections: result.selectedLabels || [],
        customInput: result.customInput,
      }
    } else {
      answers[key] = {
        selection: result.selectedLabel || null,
        customInput: result.customInput,
      }
    }
  }

  return {
    success: true,
    answers,
  }
}

/**
 * Non-interactive: validate and return a normalized question structure.
 * Useful when the agent harness presents the questions in its own UI.
 */
function prepareQuestions(questions) {
  const validation = validateQuestions(questions)
  if (!validation.valid) {
    throw new Error(validation.error)
  }

  return {
    questions: questions.map((q, i) => ({
      index: i,
      header: q.header,
      question: q.question,
      multiSelect: q.multiSelect || false,
      options: q.options.map((opt, j) => ({
        index: j + 1,
        label: opt.label,
        description: opt.description,
      })),
      otherIndex: q.options.length + 1,
    })),
    responseFormat: {
      description: 'Expected response format',
      example: {
        answers: {
          '[header]': {
            selection: 'selected label (single select)',
            selections: ['label1', 'label2'],
            customInput: 'custom text if Other selected',
          },
        },
      },
    },
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    interactive: args.includes('--interactive') || args.includes('-i'),
    demo: args.includes('--demo'),
  }

  if (flags.help) {
    console.log(`
AskUserQuestion — multiple-choice prompt for the user

Usage:
  bun ask-user-question.js [options]

Options:
  --interactive, -i  Run the demo questions interactively
  --demo             Same as -i
  --json             Output JSON
  --help             Show this help

Question shape:
  {
    "questions": [
      {
        "question": "What should we use?",
        "header": "Short tag",       // ≤ 12 chars
        "multiSelect": false,
        "options": [
          { "label": "A", "description": "..." },
          { "label": "B", "description": "..." }
        ]
      }
    ]
  }

Limits:
  - 1-${CONFIG.MAX_QUESTIONS} questions
  - ${CONFIG.MIN_OPTIONS}-${CONFIG.MAX_OPTIONS} options each
  - header ≤ 12 chars
  - "Other" is always appended automatically

Programmatic:
  import { askUserQuestions, prepareQuestions } from './ask-user-question.js'
`)
    process.exit(0)
  }

  try {
    const demoQuestions = [
      {
        question: 'Which library should we use for date formatting?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'date-fns (Recommended)', description: 'Lightweight, tree-shakeable' },
          { label: 'moment.js', description: 'Feature-rich, larger bundle' },
          { label: 'dayjs', description: 'Moment-compatible, small size' },
        ],
      },
      {
        question: 'Which features do you want to enable?',
        header: 'Features',
        multiSelect: true,
        options: [
          { label: 'TypeScript', description: 'Add type definitions' },
          { label: 'ESLint', description: 'Code linting' },
          { label: 'Prettier', description: 'Code formatting' },
          { label: 'Tests', description: 'Unit test setup' },
        ],
      },
    ]

    if (flags.demo || flags.interactive) {
      console.log('AskUserQuestion Demo\n')
      console.log('This will ask you a series of questions.\n')

      const result = await askUserQuestions(demoQuestions)

      console.log('\n--- Results ---')
      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log('Answers:')
        for (const [key, value] of Object.entries(result.answers)) {
          console.log(`  ${key}:`)
          if (value.selection) {
            console.log(`    Selected: ${value.selection}`)
          }
          if (value.selections && value.selections.length > 0) {
            console.log(`    Selected: ${value.selections.join(', ')}`)
          }
          if (value.customInput) {
            console.log(`    Custom: ${value.customInput}`)
          }
        }
      }
    } else {
      const prepared = prepareQuestions(demoQuestions)

      if (flags.json) {
        console.log(JSON.stringify(prepared, null, 2))
      } else {
        console.log('Prepared questions structure:')
        for (const q of prepared.questions) {
          console.log(`\n[${q.header}] ${q.question}`)
          console.log(`  Multi-select: ${q.multiSelect}`)
          console.log('  Options:')
          for (const opt of q.options) {
            console.log(`    ${opt.index}. ${opt.label} - ${opt.description}`)
          }
          console.log(`    ${q.otherIndex}. Other (custom input)`)
        }
      }
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export {
  askUserQuestions,
  prepareQuestions,
  validateQuestions,
  formatQuestion,
  parseSelection,
  CONFIG,
}

if (import.meta.main) {
  main()
}
