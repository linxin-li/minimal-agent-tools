#!/usr/bin/env bun
/**
 * Skill — load and invoke prompt-based skills (built-in + user-defined).
 *
 * A "skill" is a markdown file with YAML frontmatter (name, description, triggers)
 * and a prompt body. The agent expands a skill by name or by trigger phrase
 * (e.g. "/commit") into a full prompt that's prepended to the next LLM turn.
 *
 * Custom skills live in `process.env.AGENT_SKILLS_DIR` if set, otherwise the
 * platform default below.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CONFIG = {
  SKILLS_DIR: process.env.AGENT_SKILLS_DIR || path.join(os.homedir(), '.agent', 'skills'),
  SKILL_EXTENSION: '.md',
}

/**
 * Built-in skills. Tiny demonstrative set — fork and add your own.
 */
const BUILTIN_SKILLS = {
  commit: {
    name: 'commit',
    description: 'Create a git commit with a well-formatted message',
    triggers: ['/commit', 'commit changes', 'git commit'],
    prompt: `
Create a git commit following these steps:

1. Run \`git status\` to see changes
2. Run \`git diff --staged\` to see staged changes
3. If no staged changes, suggest what to stage
4. Create a commit message following conventional commits format:
   - type(scope): description
   - Types: feat, fix, docs, style, refactor, test, chore
5. Run \`git commit -m "message"\`

Ask for confirmation before committing.
`,
  },

  'review-pr': {
    name: 'review-pr',
    description: 'Review a pull request',
    triggers: ['/review-pr', 'review pr', 'pr review'],
    prompt: `
Review the pull request following these steps:

1. Get PR details using \`gh pr view <number>\`
2. Get the diff using \`gh pr diff <number>\`
3. Analyze the changes for:
   - Code quality
   - Potential bugs
   - Security issues
   - Performance concerns
   - Test coverage
4. Provide structured feedback with:
   - Summary
   - Strengths
   - Concerns
   - Suggestions
`,
  },

  init: {
    name: 'init',
    description: 'Initialize a new project',
    triggers: ['/init', 'init project', 'new project'],
    prompt: `
Help initialize a new project:

1. Ask what type of project (Node.js, Python, etc.)
2. Create appropriate directory structure
3. Initialize version control (git init)
4. Create essential files:
   - README.md
   - .gitignore
   - package.json / pyproject.toml / etc.
5. Set up basic configuration
`,
  },

  test: {
    name: 'test',
    description: 'Run tests for the project',
    triggers: ['/test', 'run tests', 'test'],
    prompt: `
Run tests for the current project:

1. Detect the project type and test framework
2. Run the appropriate test command:
   - Node.js: npm test / yarn test / pnpm test
   - Python: pytest / python -m unittest
   - Go: go test ./...
   - Rust: cargo test
3. Report test results
4. Suggest fixes for failing tests
`,
  },

  build: {
    name: 'build',
    description: 'Build the project',
    triggers: ['/build', 'build project'],
    prompt: `
Build the current project:

1. Detect the project type and build system
2. Run the appropriate build command
3. Report build results
4. Suggest fixes for build errors
`,
  },

  explain: {
    name: 'explain',
    description: 'Explain code or concepts',
    triggers: ['/explain', 'explain this', 'what does this do'],
    prompt: `
Explain the selected code or concept:

1. Identify what needs explanation
2. Break down the logic step by step
3. Explain any complex patterns or algorithms
4. Provide examples if helpful
5. Suggest improvements if applicable
`,
  },
}

function loadCustomSkills(skillsDir = CONFIG.SKILLS_DIR) {
  const skills = {}

  if (!fs.existsSync(skillsDir)) {
    return skills
  }

  const files = fs.readdirSync(skillsDir)

  for (const file of files) {
    if (!file.endsWith(CONFIG.SKILL_EXTENSION)) continue

    const filePath = path.join(skillsDir, file)
    const content = fs.readFileSync(filePath, 'utf-8')
    const skillName = path.basename(file, CONFIG.SKILL_EXTENSION)

    const skill = parseSkillFile(content, skillName)
    if (skill) {
      skills[skillName] = skill
    }
  }

  return skills
}

/**
 * Parse a skill file: YAML frontmatter (description, triggers) + markdown body.
 * If no frontmatter is present, the entire file becomes the prompt.
 */
function parseSkillFile(content, name) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)

  if (!frontmatterMatch) {
    return {
      name,
      description: `Custom skill: ${name}`,
      triggers: [`/${name}`],
      prompt: content.trim(),
      source: 'custom',
    }
  }

  const frontmatter = frontmatterMatch[1]
  const prompt = frontmatterMatch[2].trim()

  // Naive YAML parser — handles "key: value" and "key: [a, b, c]".
  const meta = {}
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/)
    if (match) {
      const [, key, value] = match
      if (value.startsWith('[') && value.endsWith(']')) {
        meta[key] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/['"]/g, ''))
      } else {
        meta[key] = value.replace(/['"]/g, '')
      }
    }
  }

  return {
    name,
    description: meta.description || `Custom skill: ${name}`,
    triggers: meta.triggers || [`/${name}`],
    prompt,
    source: 'custom',
  }
}

function getAllSkills() {
  const customSkills = loadCustomSkills()

  return {
    builtin: BUILTIN_SKILLS,
    custom: customSkills,
    all: { ...BUILTIN_SKILLS, ...customSkills },
  }
}

/**
 * Find a skill by name or trigger phrase.
 */
function findSkill(query) {
  const { all } = getAllSkills()

  if (all[query]) {
    return all[query]
  }

  for (const skill of Object.values(all)) {
    for (const trigger of skill.triggers || []) {
      if (trigger.toLowerCase() === query.toLowerCase()) {
        return skill
      }
      if (trigger.startsWith('/') && trigger.slice(1).toLowerCase() === query.toLowerCase()) {
        return skill
      }
    }
  }

  return null
}

/**
 * Resolve a skill name into the expanded prompt.
 */
function invokeSkill(skillName, args = '') {
  const skill = findSkill(skillName)

  if (!skill) {
    return {
      success: false,
      error: `Skill not found: ${skillName}`,
      availableSkills: Object.keys(getAllSkills().all),
    }
  }

  let fullPrompt = skill.prompt

  if (args) {
    fullPrompt += `\n\nAdditional context/arguments: ${args}`
  }

  return {
    success: true,
    skill: {
      name: skill.name,
      description: skill.description,
      source: skill.source || 'builtin',
    },
    prompt: fullPrompt,
    message: `Skill "${skill.name}" loaded. The prompt has been expanded.`,
  }
}

function listSkills() {
  const { builtin, custom } = getAllSkills()

  return {
    builtin: Object.values(builtin).map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
    })),
    custom: Object.values(custom).map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
    })),
    total: Object.keys(builtin).length + Object.keys(custom).length,
  }
}

function createSkill(skill) {
  const { name, description, triggers, prompt } = skill

  if (!name) {
    throw new Error('Skill name is required')
  }
  if (!prompt) {
    throw new Error('Skill prompt is required')
  }

  if (!fs.existsSync(CONFIG.SKILLS_DIR)) {
    fs.mkdirSync(CONFIG.SKILLS_DIR, { recursive: true })
  }

  const content = `---
description: ${description || `Custom skill: ${name}`}
triggers: [${(triggers || [`/${name}`]).map((t) => `"${t}"`).join(', ')}]
---
${prompt}
`

  const filePath = path.join(CONFIG.SKILLS_DIR, `${name}${CONFIG.SKILL_EXTENSION}`)
  fs.writeFileSync(filePath, content, 'utf-8')

  return {
    success: true,
    message: `Skill "${name}" created`,
    path: filePath,
  }
}

function deleteSkill(name) {
  if (BUILTIN_SKILLS[name]) {
    return { success: false, error: 'Cannot delete builtin skill' }
  }

  const filePath = path.join(CONFIG.SKILLS_DIR, `${name}${CONFIG.SKILL_EXTENSION}`)

  if (!fs.existsSync(filePath)) {
    return { success: false, error: `Skill not found: ${name}` }
  }

  fs.unlinkSync(filePath)

  return {
    success: true,
    message: `Skill "${name}" deleted`,
  }
}

// ============ CLI ============
async function main() {
  const args = process.argv.slice(2)

  const flags = {
    help: args.includes('--help') || args.includes('-h'),
    json: args.includes('--json'),
    list: args.includes('--list') || args.includes('-l'),
    create: args.includes('--create') || args.includes('-c'),
    delete: args.includes('--delete') || args.includes('-d'),
    invoke: args.includes('--invoke') || args.includes('-i'),
  }

  const skillName = args.find((arg, idx) => {
    if (arg.startsWith('-')) return false
    if (idx > 0 && ['--create', '--delete', '--invoke', '-c', '-d', '-i'].includes(args[idx - 1]))
      return false
    return true
  })

  const argsIdx = args.indexOf('--args')
  const skillArgs = argsIdx !== -1 ? args[argsIdx + 1] : ''

  let description = ''
  let triggers = []
  let prompt = ''

  const descIdx = args.indexOf('--description')
  if (descIdx !== -1) description = args[descIdx + 1]

  const triggerIdx = args.indexOf('--triggers')
  if (triggerIdx !== -1) triggers = args[triggerIdx + 1].split(',')

  const promptIdx = args.indexOf('--prompt')
  if (promptIdx !== -1) prompt = args[promptIdx + 1]

  if (flags.help) {
    console.log(`
Skill — load and invoke prompt-based skills

Usage:
  bun skill.js <skill_name> [options]
  bun skill.js --invoke <skill_name> [--args "extra args"]

Actions:
  --list, -l          List every available skill
  --invoke, -i        Invoke a skill
  --create, -c        Create a custom skill
  --delete, -d        Delete a custom skill

Arguments:
  <skill_name>        Skill name (e.g. commit, review-pr)
  --args <text>       Extra arguments to pass through
  --description <text> (create)
  --triggers <list>   Comma-separated trigger phrases (create)
  --prompt <text>     Skill prompt body (create)

Options:
  --json              Output JSON
  --help              Show this help

Built-in skills:
${Object.values(BUILTIN_SKILLS)
  .map((s) => `  /${s.name.padEnd(12)} - ${s.description}`)
  .join('\n')}

Custom skills directory: ${CONFIG.SKILLS_DIR}
(override with the AGENT_SKILLS_DIR env var)

Examples:
  bun skill.js --list
  bun skill.js commit
  bun skill.js --invoke review-pr --args "123"
  bun skill.js --create my-skill --description "..." --prompt "Do X"
  bun skill.js --delete my-skill
`)
    process.exit(0)
  }

  try {
    let result

    if (flags.list) {
      result = listSkills()

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(`Total skills: ${result.total}\n`)
        console.log('Builtin skills:')
        for (const s of result.builtin) {
          console.log(`  /${s.name.padEnd(12)} - ${s.description}`)
        }
        if (result.custom.length > 0) {
          console.log('\nCustom skills:')
          for (const s of result.custom) {
            console.log(`  /${s.name.padEnd(12)} - ${s.description}`)
          }
        }
      }
    } else if (flags.create) {
      if (!skillName) {
        console.error('Error: skill name is required')
        process.exit(1)
      }
      if (!prompt) {
        console.error('Error: --prompt is required')
        process.exit(1)
      }

      result = createSkill({
        name: skillName,
        description,
        triggers: triggers.length > 0 ? triggers : undefined,
        prompt,
      })

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(result.message)
        console.log(`Path: ${result.path}`)
      }
    } else if (flags.delete) {
      if (!skillName) {
        console.error('Error: skill name is required')
        process.exit(1)
      }

      result = deleteSkill(skillName)

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.success) {
          console.error('Error:', result.error)
          process.exit(1)
        }
        console.log(result.message)
      }
    } else if (skillName || flags.invoke) {
      const name = skillName || args[args.indexOf('--invoke') + 1] || args[args.indexOf('-i') + 1]

      if (!name) {
        console.error('Error: skill name is required')
        process.exit(1)
      }

      result = invokeSkill(name, skillArgs)

      if (flags.json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        if (!result.success) {
          console.error('Error:', result.error)
          console.log('Available skills:', result.availableSkills.join(', '))
          process.exit(1)
        }
        console.log(`Skill: ${result.skill.name}`)
        console.log(`Source: ${result.skill.source}`)
        console.log(`Description: ${result.skill.description}`)
        console.log('\n--- Expanded Prompt ---')
        console.log(result.prompt)
      }
    } else {
      result = listSkills()
      console.log(`${result.total} skills available. Use --list for details or --help for usage.`)
    }
  } catch (error) {
    console.error('Error:', error.message)
    process.exit(1)
  }
}

export {
  invokeSkill,
  findSkill,
  listSkills,
  createSkill,
  deleteSkill,
  getAllSkills,
  loadCustomSkills,
  BUILTIN_SKILLS,
  CONFIG,
}

if (import.meta.main) {
  main()
}
