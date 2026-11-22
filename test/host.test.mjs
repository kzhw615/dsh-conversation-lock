/**
 * Host-half contract tests.
 *
 * These drive `apply` with a hand-built context: the two browser operations are
 * invoked through the registered node:http handler, and the two tools through
 * their registered definitions. Nothing here needs a running Harness, a
 * browser, or a real Agent — the point is the lock decision, the delivery path,
 * and the durable round-trip.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import { apply } from '../index.js'

let home
let previousHome

// Each test owns an empty Harness home, so a saved unlock decision from one
// test can never be read by the next one.
beforeEach(async () => {
  previousHome = process.env.DSH_HOME
  home = await mkdtemp(join(tmpdir(), 'dsh-conversation-lock-'))
  process.env.DSH_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

/** Build a context with the services `apply` reaches for. */
function createHarness() {
  const tools = new Map()
  const routes = []
  const agents = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const connection = {
    admit() {
      return { peer: {} }
    },
  }
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    agents: {
      list: () => [...agents.values()],
      get: id => agents.get(id),
    },
    get: () => undefined,
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    inject(names, callback) {
      callback({
        get: name => (name === 'webServer' ? webServer : name === 'connection' ? connection : undefined),
        effect(inner) {
          const disposer = inner()
          if (typeof disposer === 'function') disposers.push(disposer)
          return () => {}
        },
      })
    },
  }
  return { ctx, tools, routes, agents }
}

/** Invoke the package route the way the http carrier does. */
async function callRoute(route, endpoint, body, method = 'POST') {
  const req = {
    method,
    url: `${route.path}/${endpoint}`,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  let status
  let headers
  let payload
  await route.handler(req, {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus
      headers = nextHeaders
    },
    end(chunk) {
      payload = chunk
    },
  })
  const text = payload === undefined ? undefined : String(payload)
  return {
    status,
    headers,
    body: text === undefined || text === '' || headers?.['content-type']?.includes('json') !== true
      ? text
      : JSON.parse(text),
  }
}

/** One live-Agent stand-in that records how a message reached it. */
function createAgent(id, status = 'idle') {
  const received = []
  return {
    id,
    status,
    session: { id, header: { cwd: `/workspace/${id}` } },
    received,
    followup(message) {
      received.push({ via: 'followup', message })
    },
    send(message, target, wakeup) {
      received.push({ via: 'send', target, wakeup, message })
    },
  }
}

test('every conversation starts locked and is reported by list', async () => {
  const { ctx, routes, tools } = createHarness()
  await apply(ctx)
  assert.equal(routes.length, 1)
  assert.deepEqual([...tools.keys()].sort(), ['list_conversations', 'send_conversation_message'])

  const listed = await callRoute(routes[0], 'list', {})
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body, { ok: true, value: { unlocked: [] } })

  const state = await callRoute(routes[0], 'state', { sessionId: 'alpha' })
  assert.deepEqual(state.body, { ok: true, value: { sessionId: 'alpha', unlocked: false } })
})

test('set unlocks and re-locks, and rejects a malformed body', async () => {
  const { ctx, routes } = createHarness()
  await apply(ctx)
  const route = routes[0]

  const opened = await callRoute(route, 'set', { sessionId: 'alpha', unlocked: true })
  assert.deepEqual(opened.body, { ok: true, value: { sessionId: 'alpha', unlocked: true } })
  assert.deepEqual((await callRoute(route, 'list', {})).body.value.unlocked, ['alpha'])

  const closed = await callRoute(route, 'set', { sessionId: 'alpha', unlocked: false })
  assert.deepEqual(closed.body, { ok: true, value: { sessionId: 'alpha', unlocked: false } })
  assert.deepEqual((await callRoute(route, 'list', {})).body.value.unlocked, [])

  const missing = await callRoute(route, 'set', { unlocked: true })
  assert.equal(missing.body.ok, false)
  assert.equal(missing.body.error.code, 'bad-request')

  const wrong = await callRoute(route, 'set', { sessionId: 'alpha', unlocked: 'yes' })
  assert.equal(wrong.body.error.code, 'bad-request')

  const unknown = await callRoute(route, 'nope', {})
  assert.equal(unknown.body.error.code, 'not-found')

  const get = await callRoute(route, 'list', undefined, 'GET')
  assert.equal(get.status, 405)
  assert.equal(get.headers.allow, 'POST')
})

test('a locked conversation refuses delivery and explains how to open it', async () => {
  const { ctx, tools, agents } = createHarness()
  await apply(ctx)
  agents.set('beta', createAgent('beta'))

  const send = tools.get('send_conversation_message')
  await assert.rejects(
    () => send.execute({ sessionId: 'beta', message: 'hello' }, { agent: { id: 'alpha' } }),
    /is locked/u,
  )
  assert.equal(agents.get('beta').received.length, 0)
})

test('an unlocked idle conversation receives one queued turn', async () => {
  const { ctx, tools, routes, agents } = createHarness()
  await apply(ctx)
  const target = createAgent('beta')
  agents.set('beta', target)
  await callRoute(routes[0], 'set', { sessionId: 'beta', unlocked: true })

  const result = await tools.get('send_conversation_message')
    .execute({ sessionId: 'beta', message: 'please review the diff' }, { agent: { id: 'alpha' } })

  assert.equal(result.delivery, 'queue')
  assert.equal(target.received.length, 1)
  const [entry] = target.received
  assert.equal(entry.via, 'followup')
  assert.equal(entry.message.role, 'user')
  assert.equal(entry.message.source.kind, 'agent-message')
  assert.equal(entry.message.source.senderSessionId, 'alpha')
  assert.match(entry.message.content[0].text, /please review the diff/u)
  assert.equal(entry.message.id, result.messageId)
})

test('an unlocked busy conversation is steered at its next step', async () => {
  const { ctx, tools, routes, agents } = createHarness()
  await apply(ctx)
  const target = createAgent('beta', 'running')
  agents.set('beta', target)
  await callRoute(routes[0], 'set', { sessionId: 'beta', unlocked: true })

  const result = await tools.get('send_conversation_message')
    .execute({ sessionId: 'beta', message: 'stop; use the other branch' }, { agent: { id: 'alpha' } })

  assert.equal(result.delivery, 'steer')
  assert.equal(target.received[0].via, 'send')
  assert.equal(target.received[0].target, 'next-step')
  assert.equal(target.received[0].wakeup, true)
})

test('explicit delivery overrides the busy default', async () => {
  const { ctx, tools, routes, agents } = createHarness()
  await apply(ctx)
  const target = createAgent('beta', 'running')
  agents.set('beta', target)
  await callRoute(routes[0], 'set', { sessionId: 'beta', unlocked: true })

  const result = await tools.get('send_conversation_message')
    .execute({ sessionId: 'beta', message: 'later', delivery: 'queue' }, { agent: { id: 'alpha' } })
  assert.equal(result.delivery, 'queue')
  assert.equal(target.received[0].via, 'followup')
})

test('delivery rejects a self target, an unknown target, and a bad argument', async () => {
  const { ctx, tools, routes, agents } = createHarness()
  await apply(ctx)
  agents.set('alpha', createAgent('alpha'))
  const send = tools.get('send_conversation_message')

  await assert.rejects(() => send.execute({ sessionId: 'alpha', message: 'hi' }, { agent: { id: 'alpha' } }), /sending conversation/u)

  await callRoute(routes[0], 'set', { sessionId: 'ghost', unlocked: true })
  await assert.rejects(() => send.execute({ sessionId: 'ghost', message: 'hi' }, { agent: { id: 'alpha' } }), /is not open in this Host/u)

  await assert.rejects(() => send.execute({ sessionId: 'alpha', message: '' }, { agent: { id: 'alpha' } }), /non-empty/u)
  await assert.rejects(() => send.execute({ sessionId: 'alpha', message: 'hi', delivery: 'shout' }, { agent: { id: 'alpha' } }), /queue/u)
  await assert.rejects(() => send.execute({ sessionId: 'alpha', message: 'hi' }, {}), /owning agent session/u)
})

test('list_conversations reports every live conversation with its lock state', async () => {
  const { ctx, tools, routes, agents } = createHarness()
  await apply(ctx)
  agents.set('alpha', createAgent('alpha'))
  agents.set('beta', createAgent('beta', 'running'))
  await callRoute(routes[0], 'set', { sessionId: 'beta', unlocked: true })

  const listing = await tools.get('list_conversations').execute({}, {})
  assert.deepEqual(listing.conversations.map(row => [row.sessionId, row.unlocked, row.status]), [
    ['alpha', false, 'idle'],
    ['beta', true, 'running'],
  ])
})

test('the unlock decision survives a restart of the Host half', async () => {
  const first = createHarness()
  await apply(first.ctx)
  await callRoute(first.routes[0], 'set', { sessionId: 'kept-open', unlocked: true })
  await callRoute(first.routes[0], 'set', { sessionId: 'later-closed', unlocked: true })
  await callRoute(first.routes[0], 'set', { sessionId: 'later-closed', unlocked: false })

  const stored = JSON.parse(await readFile(join(home, 'conversation-lock', 'state.json'), 'utf8'))
  assert.equal(stored.version, 1)
  assert.deepEqual(Object.keys(stored.sessions), ['kept-open'])
  assert.equal(typeof stored.sessions['kept-open'].unlockedAt, 'string')

  const second = createHarness()
  await apply(second.ctx)
  assert.deepEqual((await callRoute(second.routes[0], 'list', {})).body.value.unlocked, ['kept-open'])
})

test('an unreadable state file leaves every conversation locked', async () => {
  const brokenHome = await mkdtemp(join(tmpdir(), 'dsh-conversation-lock-broken-'))
  process.env.DSH_HOME = brokenHome
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(brokenHome, 'conversation-lock'), { recursive: true })
    await writeFile(join(brokenHome, 'conversation-lock', 'state.json'), '{ this is not json', 'utf8')

    const { ctx, routes } = createHarness()
    await apply(ctx)
    assert.deepEqual((await callRoute(routes[0], 'list', {})).body.value.unlocked, [])
  } finally {
    process.env.DSH_HOME = home
    await rm(brokenHome, { recursive: true, force: true })
  }
})
