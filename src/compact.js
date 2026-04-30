#!/usr/bin/env bun
/**
 * Compact — slash command that summarizes conversation history to free
 * context window space, then preserves a summary + the most recent messages.
 *
 * Pattern (and the actual insight): keep a marker message — `compact_boundary`
 * — so the agent loop can filter to *only post-boundary* messages on the next
 * turn. That single boundary message is what makes the "summarize and continue"
 * pattern composable; without it you have to track turn counts everywhere.
 */

const CONFIG = {
  MAX_SUMMARY_TOKENS: 8000,
  SUMMARY_RESERVE_TOKENS: 4000,
  AUTOCOMPACT_THRESHOLD: 0.85, // auto-compact when context is 85% full

  SUMMARY_SECTIONS: [
    'Primary Request and Intent',
    'Key Technical Concepts',
    'Files and Code Sections',
    'Current State',
    'Pending Tasks',
  ],
}

/**
 * The summarizer system prompt. The five sections (request, concepts, files,
 * state, pending) cover the dimensions that actually matter for resuming work.
 */
const SUMMARY_SYSTEM_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Current State: Describe the current state of the conversation/project, what was just completed, and what the next steps are. This should be detailed enough that work can continue seamlessly.
5. Pending Tasks: List any unresolved issues or tasks that need to be addressed.

IMPORTANT:
- Always update "Current State" to reflect the most recent work - this is critical for continuity after compaction
- Include full code snippets where applicable
- Be thorough in capturing technical details`

const TITLE_SYSTEM_PROMPT = `Summarize this coding conversation in under 50 characters.
Capture the main task, key files, problems addressed, and current status.`

/**
 * Cheap token estimate. ~4 chars per token is good enough for partitioning;
 * swap in tiktoken / a real tokenizer if you need precise counts.
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function formatMessagesForSummary(messages) {
  return messages
    .map((msg) => {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        return `User: ${content}`
      } else if (msg.role === 'assistant') {
        const content = typeof msg.content === 'string' ? msg.content : extractAssistantText(msg.content)
        return `Assistant: ${content}`
      }
      return null
    })
    .filter(Boolean)
    .join('\n\n')
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return String(content)

  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Split messages into "to summarize" (older) and "to keep verbatim" (newer).
 * Walks backward from the end, accumulating until `maxTokens` is hit.
 */
function partitionMessages(messages, maxTokens = CONFIG.MAX_SUMMARY_TOKENS) {
  const messagesToKeep = []
  let totalTokens = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    const tokens = estimateTokens(content)

    if (totalTokens + tokens > maxTokens) break

    messagesToKeep.unshift(msg)
    totalTokens += tokens
  }

  const messagesToSummarize = messages.slice(0, messages.length - messagesToKeep.length)

  return { messagesToSummarize, messagesToKeep }
}

/**
 * Build a summary of the older portion of the conversation.
 *
 * @param {Array} messages
 * @param {Object} [options]
 * @param {string} [options.customInstructions]
 * @param {(args: { systemPrompt: string, userPrompt: string }) => Promise<string>} [options.llmCall]
 *        Caller-supplied LLM caller. If omitted, returns a stub for testing.
 */
async function generateSummary(messages, options = {}) {
  const { customInstructions, llmCall } = options

  if (!messages || messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const { messagesToSummarize, messagesToKeep } = partitionMessages(messages)

  if (messagesToSummarize.length === 0) {
    return {
      summary: null,
      messagesToKeep: messages,
      skipped: true,
      reason: 'Not enough messages to compact',
    }
  }

  const conversationText = formatMessagesForSummary(messagesToSummarize)

  let systemPrompt = SUMMARY_SYSTEM_PROMPT
  if (customInstructions) {
    systemPrompt += `\n\n# Additional Instructions\n${customInstructions}`
  }

  if (!llmCall) {
    return {
      summary: `[Summary of ${messagesToSummarize.length} messages]\n\n${conversationText.substring(0, 2000)}...`,
      messagesToKeep,
      skipped: false,
      messageCount: {
        summarized: messagesToSummarize.length,
        kept: messagesToKeep.length,
      },
    }
  }

  try {
    const response = await llmCall({
      systemPrompt,
      userPrompt: `Please summarize this conversation:\n\n${conversationText}`,
    })

    return {
      summary: response,
      messagesToKeep,
      skipped: false,
      messageCount: {
        summarized: messagesToSummarize.length,
        kept: messagesToKeep.length,
      },
    }
  } catch (error) {
    throw new Error(`Failed to generate summary: ${error.message}`)
  }
}

/** Pick a short title for a conversation (UI/list display). */
async function generateTitle(messages, llmCall) {
  if (!llmCall) {
    const firstUserMsg = messages.find((m) => m.role === 'user')
    if (firstUserMsg) {
      const content = typeof firstUserMsg.content === 'string' ? firstUserMsg.content : ''
      return content.substring(0, 50).trim() || 'Untitled'
    }
    return 'Untitled'
  }

  const conversationText = formatMessagesForSummary(messages.slice(0, 10))

  const response = await llmCall({
    systemPrompt: TITLE_SYSTEM_PROMPT,
    userPrompt: conversationText,
  })

  return response.substring(0, 50).trim()
}

function shouldAutoCompact(usedTokens, maxTokens) {
  const usageRatio = usedTokens / maxTokens
  return usageRatio >= CONFIG.AUTOCOMPACT_THRESHOLD
}

/**
 * Build the compact-boundary marker message. Insert it between the summary and
 * the kept messages; subsequent turns can filter on it to drop everything older.
 */
function createCompactBoundary(trigger, preTokens) {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: new Date().toISOString(),
    uuid: crypto.randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger,
      preTokens,
    },
  }
}

function isCompactBoundary(message) {
  return message?.type === 'system' && message.subtype === 'compact_boundary'
}

function findLastCompactBoundaryIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isCompactBoundary(messages[i])) {
      return i
    }
  }
  return -1
}

/**
 * Filter messages to only what's relevant after the most recent compaction.
 * Call this before sending messages to the LLM — it's the load-bearing line.
 */
function getMessagesAfterCompact(messages) {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)

  if (boundaryIndex === -1) {
    return messages
  }

  return messages.slice(boundaryIndex)
}

/**
 * Run a full compaction.
 *
 * @returns {Promise<{ success: boolean, compactedMessages?: any[], summary?: string, stats?: any, skipped?: boolean, reason?: string }>}
 */
async function compact(messages, options = {}) {
  const { customInstructions, llmCall, trigger = 'manual' } = options

  const preTokens = messages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    return sum + estimateTokens(content)
  }, 0)

  const result = await generateSummary(messages, { customInstructions, llmCall })

  if (result.skipped) {
    return {
      success: false,
      ...result,
    }
  }

  const compactedMessages = [
    {
      role: 'user',
      content: `[Previous conversation summary]\n\n${result.summary}`,
      isMeta: true,
    },
    createCompactBoundary(trigger, preTokens),
    ...result.messagesToKeep,
  ]

  const postTokens = compactedMessages.reduce((sum, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    return sum + estimateTokens(content)
  }, 0)

  return {
    success: true,
    compactedMessages,
    summary: result.summary,
    stats: {
      preTokens,
      postTokens,
      tokensSaved: preTokens - postTokens,
      messagesCompacted: result.messageCount.summarized,
      messagesKept: result.messageCount.kept,
    },
  }
}

// ============ Slash command interface ============

const compactCommand = {
  type: 'local',
  name: 'compact',
  description:
    'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  aliases: [],
  argumentHint: '<optional custom summarization instructions>',
  isEnabled: () => !process.env.DISABLE_COMPACT,
  isHidden: false,
  supportsNonInteractive: true,

  async call(args, context) {
    const { messages, llmCall } = context

    if (!messages || messages.length === 0) {
      throw new Error('No messages to compact')
    }

    const customInstructions = args?.trim() || undefined

    const result = await compact(messages, {
      customInstructions,
      llmCall,
      trigger: 'manual',
    })

    if (!result.success) {
      return {
        type: 'text',
        value: result.reason || 'Compaction skipped',
      }
    }

    return {
      type: 'compact',
      compactionResult: result,
      displayText: `Compacted (${result.stats.tokensSaved} tokens saved)`,
    }
  },

  userFacingName() {
    return 'compact'
  },
}

// ============ PreCompact hook interface ============

/**
 * Optional hook that runs *before* compaction.
 *   - exit code 0: stdout is appended as extra summary instructions.
 *   - exit code 2: blocks compaction entirely.
 *   - other:       stderr is shown to the user but compaction continues.
 */
const preCompactHook = {
  name: 'PreCompact',
  summary: 'Before conversation compaction',
  description: `Input to command is JSON with compaction details.
Exit code 0 - stdout appended as custom compact instructions
Exit code 2 - block compaction
Other exit codes - show stderr to user only but continue with compaction`,

  async execute(params) {
    const { trigger, customInstructions, runHook } = params

    if (!runHook) {
      return { proceed: true, customInstructions }
    }

    const input = JSON.stringify({
      trigger,
      customInstructions,
    })

    try {
      const result = await runHook('PreCompact', input)

      if (result.exitCode === 2) {
        return {
          proceed: false,
          reason: 'Blocked by PreCompact hook',
        }
      }

      if (result.exitCode === 0 && result.stdout) {
        return {
          proceed: true,
          customInstructions: customInstructions
            ? `${customInstructions}\n${result.stdout}`
            : result.stdout,
        }
      }

      return { proceed: true, customInstructions }
    } catch (error) {
      // Hook failures don't block compaction.
      console.error('PreCompact hook error:', error.message)
      return { proceed: true, customInstructions }
    }
  },
}

export {
  compact,
  generateSummary,
  generateTitle,
  shouldAutoCompact,
  estimateTokens,
  partitionMessages,
  formatMessagesForSummary,
  createCompactBoundary,
  isCompactBoundary,
  findLastCompactBoundaryIndex,
  getMessagesAfterCompact,
  compactCommand,
  preCompactHook,
  CONFIG,
  SUMMARY_SYSTEM_PROMPT,
  TITLE_SYSTEM_PROMPT,
}

// ============ CLI smoke test ============
if (import.meta.main) {
  const testMessages = [
    { role: 'user', content: 'Help me design a rate limiter for our API.' },
    {
      role: 'assistant',
      content:
        'A token bucket fits well — predictable bursts and steady-state limits. What rate are you targeting?',
    },
    { role: 'user', content: '100 req/min per user, with 20-request bursts.' },
    {
      role: 'assistant',
      content:
        'Token bucket with capacity=20, refill=100/60≈1.67 tokens/sec. Store per-user state in Redis.',
    },
    { role: 'user', content: 'How do I avoid Redis hot keys when one user spikes?' },
    {
      role: 'assistant',
      content:
        'Shard the bucket across N keys per user (e.g. user_id + hash(timestamp)/window). Atomic Lua script for refill+consume.',
    },
  ]

  console.log('=== Compact Smoke Test ===\n')

  console.log('Token estimation:')
  testMessages.forEach((msg, i) => {
    const tokens = estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )
    console.log(`  Message ${i + 1} (${msg.role}): ~${tokens} tokens`)
  })

  console.log('\nMessage partition (max 100 tokens to keep):')
  const { messagesToSummarize, messagesToKeep } = partitionMessages(testMessages, 100)
  console.log(`  To summarize: ${messagesToSummarize.length} messages`)
  console.log(`  To keep: ${messagesToKeep.length} messages`)

  console.log('\nCompact (without LLM — stub summary):')
  const result = await compact(testMessages, { trigger: 'manual' })
  console.log(`  Success: ${result.success}`)
  if (result.success) {
    console.log(`  Pre-tokens: ${result.stats.preTokens}`)
    console.log(`  Post-tokens: ${result.stats.postTokens}`)
    console.log(`  Tokens saved: ${result.stats.tokensSaved}`)
    console.log(`  Messages compacted: ${result.stats.messagesCompacted}`)
    console.log(`  Messages kept: ${result.stats.messagesKept}`)
  }

  console.log('\nAutocompact threshold:')
  console.log(`  85% usage: ${shouldAutoCompact(8500, 10000)} (true)`)
  console.log(`  80% usage: ${shouldAutoCompact(8000, 10000)} (false)`)

  console.log('\nBoundary message filtering:')
  const messagesWithBoundary = [
    { role: 'user', content: 'Old message 1' },
    { role: 'assistant', content: 'Old response 1' },
    createCompactBoundary('manual', 1000),
    { role: 'user', content: 'New message after compact' },
    { role: 'assistant', content: 'New response after compact' },
  ]

  console.log(`  Total messages: ${messagesWithBoundary.length}`)
  console.log(`  isCompactBoundary(msg[2]): ${isCompactBoundary(messagesWithBoundary[2])} (true)`)
  console.log(`  isCompactBoundary(msg[0]): ${isCompactBoundary(messagesWithBoundary[0])} (false)`)
  console.log(`  findLastCompactBoundaryIndex: ${findLastCompactBoundaryIndex(messagesWithBoundary)} (2)`)

  const filteredMessages = getMessagesAfterCompact(messagesWithBoundary)
  console.log(`  After filtering: ${filteredMessages.length} messages (3)`)
  console.log(`  First filtered message type: ${filteredMessages[0]?.type} (system)`)

  const messagesNoBoundary = [
    { role: 'user', content: 'Message 1' },
    { role: 'assistant', content: 'Response 1' },
  ]
  const filteredNoBoundary = getMessagesAfterCompact(messagesNoBoundary)
  console.log(`  Without boundary: ${filteredNoBoundary.length} (2, unchanged)`)

  console.log('\n=== Done ===')
}
