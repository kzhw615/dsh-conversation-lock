/**
 * Conversation lock — Host half.
 *
 * A conversation (one DSH Session) is locked by default: no other agent can
 * deliver a message into it. The user unlocks it from the conversation itself
 * (the chip in the composer tool row, the Session-row badge, or the Session
 * menu); while unlocked, any agent in this Host process may deliver a message
 * into that Session with `send_conversation_message`.
 *
 * Three seams make that possible here:
 *
 * - `ctx.agents` holds the live Agents, and every Agent accepts inbox input
 *   (`followup` for a new turn, `send(..., 'next-step', ...)` for steering).
 *   This is the delivery path — it is not the subagent tree, so it does not
 *   depend on which conversation created which agent.
 * - `ctx.tools` publishes the two model-facing tools, so an agent can discover
 *   which conversations are open and deliver into one of them.
 * - `ctx.webServer` + `ctx.connection.admit` carry the two browser operations
 *   (`list`, `set`) behind the page's own browser credential. There is no
 *   agent-facing path to unlock: only a request admitted as the browser owner
 *   Peer can change the lock.
 *
 * The lock state is a user preference, not conversation history, so it lives in
 * the profile's home directory rather than in the Session log; a Session that
 * has no record is locked.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'conversation-lock'

/** Tools, the live Agent registry, and the browser carrier are required. */
export const inject = ['tools', 'agents']

/** Absolute prefix of the package's private browser route. */
const CHANNEL = '/conversation-lock'

/** Lock file format version. */
const STATE_VERSION = 1

/** Route body cap; the payloads are tiny. */
const MAX_BODY_BYTES = 64 * 1024

/** Longest message this plugin forwards into a conversation. */
const MAX_MESSAGE_CHARS = 20000

/** Domain directory name under the harness home. */
const STATE_DIR_NAME = 'conversation-lock'

/** State file name inside {@link STATE_DIR_NAME}. */
const STATE_FILE_NAME = 'state.json'

/** Resolve the harness home the same way every other DSH package does. */
function harnessHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured
  return join(homedir(), '.dsh')
}

/** Absolute directory holding this package's lock records. */
function stateDirectory() {
  return join(harnessHome(), STATE_DIR_NAME)
}

/** Absolute path of the lock record file. */
function statePath() {
  return join(stateDirectory(), STATE_FILE_NAME)
}

/** Working model of one successful browser call. */
function ok(value) {
  return { ok: true, value }
}

/** Working model of one failed browser call. */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** Whether a decoded value is a non-array object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a required non-empty string argument. */
function requiredString(args, key) {
  const value = isRecord(args) ? args[key] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`\`${key}\` must be a non-empty string`)
  }
  return value
}

/**
 * The per-Session lock records and their durable copy.
 *
 * Reads are synchronous from memory; every mutation lands in memory, notifies
 * waiters, then appends one atomic replacement of the state file. A failed
 * write leaves the in-memory decision in force for this process and reports the
 * failure, because refusing the user's click after the state already changed
 * would be the more confusing half-measure.
 */
class LockStore {
  #records = new Map()
  #listeners = new Set()
  #writeChain = Promise.resolve()
  #loaded = false
  #logger

  constructor(logger) {
    this.#logger = logger
  }

  /** Load the stored records once, keeping the process usable when they are unreadable. */
  async load() {
    if (this.#loaded) return
    this.#loaded = true
    let text
    try {
      text = await readFile(statePath(), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn('could not read the saved lock state', error)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.#warn('the saved lock state is not valid JSON; every conversation starts locked', error)
      return
    }
    const sessions = isRecord(parsed) ? parsed.sessions : undefined
    if (!isRecord(sessions)) return
    for (const [sessionId, record] of Object.entries(sessions)) {
      if (sessionId === '' || !isRecord(record)) continue
      const unlockedAt = typeof record.unlockedAt === 'string' ? record.unlockedAt : new Date().toISOString()
      this.#records.set(sessionId, { unlockedAt })
    }
    this.#notify()
  }

  /** Whether one Session currently accepts messages from other agents. */
  isUnlocked(sessionId) {
    return this.#records.has(sessionId)
  }

  /** Every unlocked Session id, in stable order. */
  unlockedIds() {
    return [...this.#records.keys()].sort()
  }

  /** Subscribe to lock changes; the returned function removes the listener. */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Set one Session's lock and persist the result.
   * @param sessionId - the Session whose lock changes.
   * @param unlocked - the requested state.
   * @returns the applied state.
   */
  async set(sessionId, unlocked) {
    const changed = unlocked ? !this.#records.has(sessionId) : this.#records.has(sessionId)
    if (unlocked) this.#records.set(sessionId, { unlockedAt: new Date().toISOString() })
    else this.#records.delete(sessionId)
    if (changed) this.#notify()
    if (changed) await this.#persist()
    return { sessionId, unlocked: this.isUnlocked(sessionId) }
  }

  /** Notify every subscriber of a state change. */
  #notify() {
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch (error) {
        this.#warn('a lock-state listener failed', error)
      }
    }
  }

  /** Append one atomic replacement of the state file to the write chain. */
  #persist() {
    const sessions = {}
    for (const [sessionId, record] of this.#records) sessions[sessionId] = { unlockedAt: record.unlockedAt }
    const payload = `${JSON.stringify({ version: STATE_VERSION, sessions }, null, 2)}\n`
    const directory = stateDirectory()
    const target = statePath()
    const temp = `${target}.${process.pid}.tmp`
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(directory, { recursive: true })
      await writeFile(temp, payload, 'utf8')
      await rename(temp, target)
    }).catch((error) => {
      this.#warn('could not save the lock state; the change applies until this Host restarts', error)
    })
    return this.#writeChain
  }

  /** Report one non-fatal failure. */
  #warn(message, error) {
    const logger = this.#logger
    const detail = error instanceof Error ? error.message : String(error)
    if (typeof logger?.warn === 'function') logger.warn(`conversation-lock: ${message}: ${detail}`)
    else console.warn(`conversation-lock: ${message}: ${detail}`)
  }
}

/**
 * Register the package.
 * @param ctx - registrant context carrying tools and the live Agent registry.
 */
export async function apply(ctx) {
  const store = new LockStore(ctx.logger)
  await store.load()

  registerBrowserRoute(ctx, store)
  registerTools(ctx, store)
}

/**
 * Publish the two browser operations behind Connection's admission check.
 * @param ctx - registrant context.
 * @param store - the lock records.
 */
function registerBrowserRoute(ctx, store) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer')
    const connection = webCtx.get('connection')
    if (webServer === undefined || connection === undefined) {
      ctx.logger?.warn?.('conversation-lock: the web transport is unavailable, so the lock controls cannot reach this Host')
      return
    }

    /** Answer one browser request on the package's private channel. */
    async function respond(req, res) {
      const admission = connection.admit(req)
      if (admission.rejection !== undefined) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed')
        return
      }
      let result
      try {
        const payload = await readJsonBody(req)
        result = await dispatch(endpointOf(req.url), payload, store)
      } catch (error) {
        result = fail('bad-request', error instanceof Error ? error.message : String(error))
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result))
    }

    try {
      webCtx.effect(
        () => webServer.register({ kind: 'prefix', path: CHANNEL, handler: respond }),
        `conversation-lock: ${CHANNEL} route`,
      )
    } catch (error) {
      ctx.logger?.error?.('conversation-lock: could not register the lock route', error)
    }
  })
}

/** Endpoint name carried by `req.url` below the channel prefix. */
function endpointOf(rawUrl) {
  const path = (rawUrl ?? '').split('?', 1)[0] ?? ''
  if (!path.startsWith(`${CHANNEL}/`)) return ''
  return path.slice(CHANNEL.length + 1)
}

/**
 * Run one browser operation.
 * @param endpoint - `list`, `state`, or `set`.
 * @param payload - decoded JSON body.
 * @param store - the lock records.
 * @returns the browser-facing result envelope.
 */
async function dispatch(endpoint, payload, store) {
  switch (endpoint) {
    case 'list':
      return ok({ unlocked: store.unlockedIds() })
    case 'state': {
      const sessionId = isRecord(payload) ? payload.sessionId : undefined
      if (typeof sessionId !== 'string' || sessionId === '') return fail('bad-request', 'sessionId is required')
      return ok({ sessionId, unlocked: store.isUnlocked(sessionId) })
    }
    case 'set': {
      const sessionId = isRecord(payload) ? payload.sessionId : undefined
      const unlocked = isRecord(payload) ? payload.unlocked : undefined
      if (typeof sessionId !== 'string' || sessionId === '') return fail('bad-request', 'sessionId is required')
      if (typeof unlocked !== 'boolean') return fail('bad-request', 'unlocked must be a boolean')
      return ok(await store.set(sessionId, unlocked))
    }
    default:
      return fail('not-found', `unknown conversation-lock endpoint ${JSON.stringify(endpoint)}`)
  }
}

/** Read one small JSON body from a node:http request. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Publish the two agent-facing tools.
 * @param ctx - registrant context.
 * @param store - the lock records.
 */
function registerTools(ctx, store) {
  ctx.effect(() => ctx.tools.register({
    name: 'list_conversations',
    description: 'List the conversations (Sessions) running in this Harness and whether each one is unlocked. '
      + 'A locked conversation refuses messages from other agents; the user unlocks it from that conversation\'s own '
      + 'lock control. Use this to find a conversation you may deliver into before calling `send_conversation_message`.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['conversations'],
        properties: {
          conversations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sessionId', 'title', 'unlocked', 'status'],
              properties: {
                sessionId: { type: 'string', description: 'Session id to address this conversation.' },
                title: { type: 'string', description: 'Short display label.' },
                unlocked: { type: 'boolean', description: 'Whether other agents may deliver into it.' },
                status: { type: 'string', description: 'running or idle.' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.conversations.length === 0
          ? 'No conversation is open in this Host.'
          : value.conversations.map(row => `${row.unlocked ? 'unlocked' : 'locked'}  ${row.sessionId}  (${row.status})  ${row.title}`).join('\n'),
      }],
    },
    execute() {
      return Promise.resolve({
        conversations: ctx.agents.list().map((agent) => {
          const session = agent.session
          return {
            sessionId: agent.id,
            title: titleOf(ctx, session),
            unlocked: store.isUnlocked(agent.id),
            status: typeof agent.status === 'string' ? agent.status : 'unknown',
          }
        }),
      })
    },
  }), 'conversation-lock: list_conversations')

  ctx.effect(() => ctx.tools.register({
    name: 'send_conversation_message',
    description: 'Deliver one message into another conversation (Session) running in this Harness. '
      + 'Delivery requires that conversation to be unlocked by the user; this tool cannot unlock it and must not be '
      + 'used to ask for a policy change. A busy target receives the text at its next step, an idle target starts a '
      + 'turn. Success means the message entered the target inbox, never that the target replied.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['sessionId', 'message'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Target Session id, as reported by `list_conversations` or by the user.',
        },
        message: {
          type: 'string',
          description: 'The text to deliver. It is shown to the target as an agent message from this conversation.',
        },
        delivery: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue (default) adds one turn to the target; steer hands the text to its next step while it works.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'messageId', 'delivery'],
        properties: {
          sessionId: { type: 'string', description: 'Conversation that received the message.' },
          messageId: { type: 'string', description: 'Identity of the delivered message.' },
          delivery: { type: 'string', enum: ['queue', 'steer'], description: 'How it was handed to the target.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Message ${value.messageId} delivered into conversation ${value.sessionId} (${value.delivery}).`,
      }],
    },
    async execute(rawArgs, exec) {
      const sessionId = requiredString(rawArgs, 'sessionId')
      const text = requiredString(rawArgs, 'message')
      const requested = isRecord(rawArgs) ? rawArgs.delivery : undefined
      if (requested !== undefined && requested !== 'queue' && requested !== 'steer') {
        throw new Error('`delivery` must be `queue` or `steer`')
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        throw new Error(`\`message\` must be at most ${String(MAX_MESSAGE_CHARS)} characters`)
      }
      const sender = exec.agent
      if (sender === undefined) throw new Error('send_conversation_message requires an owning agent session')
      if (sender.id === sessionId) throw new Error('send_conversation_message cannot target the sending conversation')
      const target = ctx.agents.get(sessionId)
      if (target === undefined) {
        throw new Error(
          `conversation ${sessionId} is not open in this Host, so there is no agent to receive a message. `
          + 'Call `list_conversations` for the ids that are open, or ask the user to open that conversation first.',
        )
      }
      if (!store.isUnlocked(sessionId)) {
        throw new Error(
          `conversation ${sessionId} is locked. Only the user can unlock it, from that conversation's lock control `
          + '(the lock chip in its composer tool row, or Lock in its Session menu). Ask the user to unlock it, '
          + 'then call this tool again.',
        )
      }
      const message = createAgentMessage(sender.id, text)
      const running = target.status === 'running'
      const delivery = requested === 'steer' || (requested === undefined && running) ? 'steer' : 'queue'
      if (delivery === 'steer') target.send(message, 'next-step', true)
      else target.followup(message)
      return { sessionId, messageId: message.id, delivery }
    },
  }), 'conversation-lock: send_conversation_message')
}

/**
 * Build the durable user-role message a target conversation receives.
 * @param senderSessionId - the delivering conversation's Session id.
 * @param text - the delivered body.
 * @returns the model-visible message handed to the target inbox.
 */
function createAgentMessage(senderSessionId, text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `Agent from conversation ${senderSessionId} sent a message:\n\n${text}`,
    }],
    source: {
      kind: 'agent-message',
      form: 'relay',
      senderSessionId,
    },
  }
}

/**
 * Read one Session's display title, falling back to its directory name.
 * @param ctx - registrant context.
 * @param session - the Session to describe.
 * @returns a short label for the listing.
 */
function titleOf(ctx, session) {
  try {
    const snapshot = ctx.get('sessionTitle')?.get?.(session)
    const title = isRecord(snapshot) ? snapshot.title : undefined
    if (typeof title === 'string' && title.trim() !== '') return title
  } catch {
    // A title provider that is absent or failing is not a listing failure.
  }
  const cwd = isRecord(session?.header) ? session.header.cwd : undefined
  if (typeof cwd === 'string' && cwd !== '') return cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd
  return session?.id ?? 'conversation'
}
