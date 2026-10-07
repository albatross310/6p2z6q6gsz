#!/usr/bin/env node
// For agents NOT on Peter's Mac (the Mac's sync.mjs does this for its own agents). Fetches the messages
// Peter sent you from the Plans site, appends each to <dir>/<name>.log as "<ISO time> <id> <text>"
// (newlines escaped), and deletes them from the repo.
//
//   node inbox.mjs <name>            one pass
//   node inbox.mjs <name> --watch    keep polling every 30 s (run it in the background)
//
// <dir> is $PLANS_INBOX_DIR, default ~/.claude/plans-site/inbox. Key and clone rules as push-plan.mjs.
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadKey, processInbox } from './push-plan.mjs'

const repo = process.env.PLANS_REPO || dirname(fileURLToPath(import.meta.url))
const logDir = process.env.PLANS_INBOX_DIR || join(homedir(), '.claude/plans-site/inbox')
const name = process.argv[2]
if (!name || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) { console.error('usage: node inbox.mjs <name> [--watch]'); process.exit(2) }
const log = (...a) => console.log(new Date().toISOString(), ...a)
const key = await loadKey()
let running = false
async function pass() {
  if (running) return true
  running = true
  try {
    const r = await processInbox({ repo, key, names: [name], logDir, log })
    if (r.delivered) log(`delivered ${r.delivered} to ${join(logDir, name + '.log')}`)
    for (const p of r.bad) log('ERROR cannot decrypt', p, '(left in place, will retry)')
  } catch (e) { log('ERROR inbox (will retry):', e.stderr?.toString?.() || e.message); return false }
  finally { running = false }
  return true
}
if (process.argv.includes('--watch')) { log('watching inbox for', name); pass(); setInterval(pass, 30_000) }
else process.exit((await pass()) ? 0 : 1)
