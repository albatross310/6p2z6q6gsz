#!/usr/bin/env node
// Push one agent's plan to the Plans site, encrypted. Needs only git, Node 18+ and the key.
//
//   node push-plan.mjs <name> <file.md>        encrypt and push that plan
//   node push-plan.mjs --delete <name>          remove that agent's tab
//
// Run it from a DEDICATED clone of this repo (it works on the clone it lives in, and resets that clone to
// origin/main on every push, so keep no edits there). The key is the 43-character
// base64url string after "#k=" in the phone link: put it in $PLANS_KEY, or in a file named by
// $PLANS_KEY_FILE (default ~/.claude/plans-site/key). Nothing readable ever leaves the machine.
//
// Layout (all AES-256-GCM, 12-byte IV || ciphertext):
//   plans/index.enc  {synced, agents: [{id, name, updatedMs, pushedMs, from, h}]}
//   plans/<id>.enc   {name, updatedMs, text}       id = HMAC(key, "id:" + lower-case name), 16 hex
//   inbox/<id>/<msgId>.enc  {v, id, name, text, sentMs}   one message from Peter's phone (msgId = <ms>-<6 hex>)
//   replies/<id>.enc        {name, msgs: [{id, text, sentMs, deliveredMs}], replies: [{id, text, atMs}]}  last 20 each
// Messages: processInbox() (sync.mjs on the Mac, inbox.mjs elsewhere) appends each to a local log and deletes it
// from the repo; addReply() (reply.mjs) adds a reply. Both commit with git plumbing, so they never touch the
// working tree and can run beside pushPlans().
// Concurrency: every attempt starts from the latest origin/main, rebuilds the index there and pushes
// fast-forward only; a rejected push (someone else got in first) fetches and tries again. No force.
import { readFile, writeFile, appendFile, mkdir, rm, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { webcrypto, createHmac } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const subtle = webcrypto.subtle
const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function loadKey() {
  const s = (process.env.PLANS_KEY || await readFile(process.env.PLANS_KEY_FILE || join(homedir(), '.claude/plans-site/key'), 'utf8')).trim()
  const raw = Buffer.from(s, 'base64url')
  if (raw.length !== 32) throw new Error('key must be 32 bytes, base64url')
  return raw
}
export const agentId = (key, name) => createHmac('sha256', key).update('id:' + name.toLowerCase()).digest('hex').slice(0, 16)
const textMac = (key, text) => createHmac('sha256', key).update('text:' + text).digest('hex').slice(0, 16)

export async function seal(key, obj) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(obj))))
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12)
  return out
}
export async function open(key, buf) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, k, buf.subarray(12))
  return JSON.parse(new TextDecoder().decode(pt))
}

// A fetch can lose a ref-lock race with another process fetching the same clone (reply.mjs): retry.
async function fetchMain(git) {
  for (let i = 1; ; i++) {
    try { return git('fetch', '-q', 'origin', 'main') } catch (e) { if (i >= 4) throw e; await sleep(400 * i + Math.random() * 600) }
  }
}
const RACE = /rejected|non-fast-forward|fetch first|failed to push|cannot lock ref/i

/**
 * changes: [{name, text, updatedMs?}] to set, [{name, delete: true}] to remove.
 * prune(entry): optional; index entries it returns true for are removed (the Mac drops its own deleted files).
 * Returns 'pushed' or 'unchanged'.
 */
export async function pushPlans({ repo, key, changes, from = hostname(), prune, log = () => {} }) {
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  for (let attempt = 1; attempt <= 10; attempt++) {
    await fetchMain(git)
    git('checkout', '-q', '-B', 'main', 'origin/main') // start from whatever is live now
    git('reset', '-q', '--hard', 'origin/main')
    const dir = join(repo, 'plans')
    await mkdir(dir, { recursive: true })
    const idxPath = join(dir, 'index.enc')
    const index = await readFile(idxPath).then(b => open(key, b), () => ({ agents: [] }))
    const byId = new Map(index.agents.map(a => [a.id, a]))
    let changed = false
    const touched = []
    for (const c of changes) {
      const id = agentId(key, c.name)
      if (c.delete) {
        if (byId.delete(id)) { await rm(join(dir, `${id}.enc`), { force: true }); changed = true; touched.push('-' + c.name) }
        continue
      }
      const h = textMac(key, c.text), old = byId.get(id)
      if (old && old.h === h && old.name === c.name) continue
      const updatedMs = c.updatedMs ?? Date.now()
      await writeFile(join(dir, `${id}.enc`), await seal(key, { name: c.name, updatedMs, text: c.text }))
      byId.set(id, { id, name: c.name, updatedMs, pushedMs: Date.now(), from, h })
      changed = true; touched.push(c.name)
    }
    if (prune) for (const [id, e] of byId) if (prune(e)) { byId.delete(id); await rm(join(dir, `${id}.enc`), { force: true }); changed = true; touched.push('-' + e.name) }
    if (!changed) return 'unchanged'
    await writeFile(idxPath, await seal(key, { synced: Date.now(), agents: [...byId.values()] }))
    git('add', '-A', 'plans')
    const names = touched.join(', ')
    git('commit', '-q', '-m', `plans update\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`)
    try {
      git('push', '-q', 'origin', 'HEAD:main') // fast-forward only; never forced
      log(`pushed ${names} (attempt ${attempt})`)
      return 'pushed'
    } catch (e) {
      const msg = String(e.stderr || e.message)
      if (!RACE.test(msg)) throw e
      log(`push raced (attempt ${attempt}), retrying`)
      await sleep(500 + Math.random() * 2500 * attempt)
    }
  }
  throw new Error('gave up after 10 attempts')
}

// ---- messages ----

/**
 * Commit on top of the latest origin/main without touching the working tree (temporary index + commit-tree),
 * then push fast-forward; a rejected push starts again from the new origin/main. build({read, list}) is
 * called once per attempt and returns {set: {path: Buffer}, del: [path], message} or null for "nothing to do".
 * read(path) -> Buffer | null, list(prefix) -> [path].
 */
export async function commitFiles({ repo, build, log = () => {} }) {
  const run = (args, opts = {}) => execFileSync('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts })
  const git = (...a) => run(a, { encoding: 'utf8' }).trim()
  const gitDir = git('rev-parse', '--absolute-git-dir')
  for (let attempt = 1; attempt <= 10; attempt++) {
    await fetchMain(git)
    const base = git('rev-parse', 'origin/main')
    const read = path => { try { return run(['cat-file', 'blob', `${base}:${path}`]) } catch { return null } }
    const list = prefix => git('ls-tree', '-r', '--name-only', base, '--', prefix).split('\n').filter(Boolean)
    const r = await build({ read, list })
    const set = Object.entries(r?.set || {}), del = (r?.del || []).filter(p => read(p) !== null)
    if (!set.length && !del.length) return 'unchanged'
    const idx = join(gitDir, `plumb-index-${process.pid}-${Math.random().toString(16).slice(2)}`)
    const env = { ...process.env, GIT_INDEX_FILE: idx }
    let commit
    try {
      run(['read-tree', base], { env })
      for (const [path, buf] of set) {
        const sha = run(['hash-object', '-w', '--stdin'], { input: buf, encoding: 'utf8' }).trim()
        run(['update-index', '--add', '--cacheinfo', `100644,${sha},${path}`], { env })
      }
      for (const path of del) run(['update-index', '--force-remove', '--', path], { env })
      const tree = run(['write-tree'], { env, encoding: 'utf8' }).trim()
      commit = run(['commit-tree', tree, '-p', base, '-m', `${r.message || 'messages'}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`], { encoding: 'utf8' }).trim()
    } finally { await rm(idx, { force: true }) }
    try {
      run(['push', '-q', 'origin', `${commit}:refs/heads/main`]) // fast-forward only; never forced
      return 'pushed'
    } catch (e) {
      if (!RACE.test(String(e.stderr || e.message))) throw e
      log(`push raced (attempt ${attempt}), retrying`)
      await sleep(500 + Math.random() * 2500 * attempt)
    }
  }
  throw new Error('gave up after 10 attempts')
}

const KEEP = 20
const MSG_ID = /^\d{13}-[0-9a-f]{6}$/
// A missing thread is empty; one that will not decrypt is an error (never overwrite it with an empty one).
async function readThread(key, read, id, name) {
  const b = read(`replies/${id}.enc`)
  const t = b ? await open(key, b) : {}
  return { name: t.name || name, msgs: t.msgs || [], replies: t.replies || [] }
}
function trimThread(t) {
  t.msgs = t.msgs.sort((a, b) => a.sentMs - b.sentMs).slice(-KEEP)
  t.replies = t.replies.sort((a, b) => a.atMs - b.atMs).slice(-KEEP)
  return t
}
// One log line: "<ISO time> <id> <text>", newlines escaped, so `tail -F` gives one line per message.
export const logLine = (atMs, id, text) =>
  `${new Date(atMs).toISOString().replace(/\.\d+Z$/, 'Z')} ${id} ${text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\n`

/**
 * Pull new messages for `names` (the agents this machine owns), append each to <logDir>/<name>.log, then
 * delete the processed inbox files and mark them delivered in replies/<id>.enc, in one commit.
 * A message whose id is already in the log is not appended twice (a failed push is simply redone next time).
 * Files that fail to decrypt are left in place and reported; errors (fetch, push) throw.
 * Returns {delivered: n, bad: [path]}.
 */
export async function processInbox({ repo, key, names, logDir, log = () => {} }) {
  const mine = new Map(names.map(n => [agentId(key, n), n]))
  await mkdir(logDir, { recursive: true })
  for (const n of names) await appendFile(join(logDir, `${n}.log`), '') // so `tail -F` has a file from day one
  let delivered = 0, bad = []
  await commitFiles({ repo, log, build: async ({ read, list }) => {
    delivered = 0; bad = []
    const byAgent = new Map()
    for (const path of list('inbox')) {
      const m = /^inbox\/([0-9a-f]{16})\/(\d{13}-[0-9a-f]{6})\.enc$/.exec(path)
      if (!m || !mine.has(m[1])) continue // another machine's agent, or not a message
      let msg
      try { msg = await open(key, read(path)) } catch (e) { bad.push(path); continue }
      if (msg.id !== m[2] || agentId(key, String(msg.name)) !== m[1] || typeof msg.text !== 'string') { bad.push(path); continue }
      if (!byAgent.has(m[1])) byAgent.set(m[1], [])
      byAgent.get(m[1]).push({ path, msg })
    }
    const set = {}, del = []
    for (const [id, items] of byAgent) {
      const name = mine.get(id), file = join(logDir, `${name}.log`)
      items.sort((a, b) => a.msg.id.localeCompare(b.msg.id))
      const t = await readThread(key, read, id, name)
      const have = await readFile(file, 'utf8').catch(() => '')
      const now = Date.now()
      for (const { path, msg } of items) {
        if (!have.includes(` ${msg.id} `)) await appendFile(file, logLine(now, msg.id, msg.text))
        if (!t.msgs.some(x => x.id === msg.id)) t.msgs.push({ id: msg.id, text: msg.text, sentMs: msg.sentMs, deliveredMs: now })
        del.push(path); delivered++
      }
      set[`replies/${id}.enc`] = Buffer.from(await seal(key, trimThread(t)))
    }
    return { set, del, message: 'messages delivered' }
  } })
  return { delivered, bad }
}

/** Add a reply under message `msgId` in <name>'s thread, and push it. */
export async function addReply({ repo, key, name, msgId, text, log = () => {} }) {
  if (!MSG_ID.test(msgId)) throw new Error(`message id should look like 1759845000000-a1b2c3, got "${msgId}"`)
  const id = agentId(key, name)
  let known = false
  const r = await commitFiles({ repo, log, build: async ({ read }) => {
    const t = await readThread(key, read, id, name)
    known = t.msgs.some(m => m.id === msgId)
    t.replies.push({ id: msgId, text, atMs: Date.now() })
    return { set: { [`replies/${id}.enc`]: Buffer.from(await seal(key, trimThread(t))) }, message: 'reply' }
  } })
  return { result: r, known }
}

// ---- CLI ----
if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  const args = process.argv.slice(2)
  const repo = dirname(fileURLToPath(import.meta.url))
  const del = args[0] === '--delete'
  const [name, file] = del ? args.slice(1) : args
  if (!name || !/^[A-Za-z0-9_-]{1,40}$/.test(name) || (!del && !file)) {
    console.error('usage: node push-plan.mjs <name> <file.md>   |   node push-plan.mjs --delete <name>')
    process.exit(2)
  }
  try {
    const key = await loadKey()
    const changes = del ? [{ name, delete: true }]
      : [{ name, text: await readFile(file, 'utf8'), updatedMs: Math.round((await stat(file)).mtimeMs) }]
    console.log(await pushPlans({ repo, key, changes, log: m => console.log(m) }))
  } catch (e) { console.error('push-plan:', e.stderr?.toString?.() || e.message); process.exit(1) }
}
