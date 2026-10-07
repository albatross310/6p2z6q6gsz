#!/usr/bin/env node
// Push one agent's plan to the Plans site, encrypted. Needs only git, Node 18+ and the key.
//
//   node push-plan.mjs <name> <file.md>        encrypt and push that plan
//   node push-plan.mjs --delete <name>          remove that agent's tab
//
// Run it inside a clone of this repo (it works on the clone it lives in). The key is the 43-character
// base64url string after "#k=" in the phone link: put it in $PLANS_KEY, or in a file named by
// $PLANS_KEY_FILE (default ~/.claude/plans-site/key). Nothing readable ever leaves the machine.
//
// Layout (all AES-256-GCM, 12-byte IV || ciphertext):
//   plans/index.enc  {synced, agents: [{id, name, updatedMs, pushedMs, from, h}]}
//   plans/<id>.enc   {name, updatedMs, text}       id = HMAC(key, "id:" + lower-case name), 16 hex
// Concurrency: every attempt starts from the latest origin/main, rebuilds the index there and pushes
// fast-forward only; a rejected push (someone else got in first) fetches and tries again. No force.
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
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
const agentId = (key, name) => createHmac('sha256', key).update('id:' + name.toLowerCase()).digest('hex').slice(0, 16)
const textMac = (key, text) => createHmac('sha256', key).update('text:' + text).digest('hex').slice(0, 16)

async function seal(key, obj) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(obj))))
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12)
  return out
}
async function open(key, buf) {
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, k, buf.subarray(12))
  return JSON.parse(new TextDecoder().decode(pt))
}

/**
 * changes: [{name, text, updatedMs?}] to set, [{name, delete: true}] to remove.
 * prune(entry): optional; index entries it returns true for are removed (the Mac drops its own deleted files).
 * Returns 'pushed' or 'unchanged'.
 */
export async function pushPlans({ repo, key, changes, from = hostname(), prune, log = () => {} }) {
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  for (let attempt = 1; attempt <= 10; attempt++) {
    git('fetch', '-q', 'origin', 'main')
    git('checkout', '-q', '-B', 'main', 'origin/main') // start from whatever is live now
    git('reset', '-q', '--hard', 'origin/main')
    const dir = join(repo, 'plans')
    await mkdir(dir, { recursive: true })
    const idxPath = join(dir, 'index.enc')
    const index = await readFile(idxPath).then(b => open(key, b), () => ({ agents: [] }))
    const byId = new Map(index.agents.map(a => [a.id, a]))
    let changed = false
    for (const c of changes) {
      const id = agentId(key, c.name)
      if (c.delete) {
        if (byId.delete(id)) { await rm(join(dir, `${id}.enc`), { force: true }); changed = true }
        continue
      }
      const h = textMac(key, c.text), old = byId.get(id)
      if (old && old.h === h && old.name === c.name) continue
      const updatedMs = c.updatedMs ?? Date.now()
      await writeFile(join(dir, `${id}.enc`), await seal(key, { name: c.name, updatedMs, text: c.text }))
      byId.set(id, { id, name: c.name, updatedMs, pushedMs: Date.now(), from, h })
      changed = true
    }
    if (prune) for (const [id, e] of byId) if (prune(e)) { byId.delete(id); await rm(join(dir, `${id}.enc`), { force: true }); changed = true }
    if (!changed) return 'unchanged'
    await writeFile(idxPath, await seal(key, { synced: Date.now(), agents: [...byId.values()] }))
    git('add', '-A', 'plans')
    const names = changes.map(c => c.name).join(', ') || 'prune'
    git('commit', '-q', '-m', `plans: ${from}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`)
    try {
      git('push', '-q', 'origin', 'HEAD:main') // fast-forward only; never forced
      log(`pushed ${names} (attempt ${attempt})`)
      return 'pushed'
    } catch (e) {
      const msg = String(e.stderr || e.message)
      if (!/rejected|non-fast-forward|fetch first|failed to push/i.test(msg)) throw e
      log(`push raced (attempt ${attempt}), retrying`)
      await sleep(500 + Math.random() * 2500 * attempt)
    }
  }
  throw new Error('gave up after 10 attempts')
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
