#!/usr/bin/env node
// Reply to a message Peter sent from the Plans site. It shows under that message on his phone (~1 min).
//
//   node reply.mjs <name> <message-id> "<text>"
//
// <message-id> is the second field of the line in your inbox log (e.g. 1759845000000-a1b2c3).
// Same key and clone rules as push-plan.mjs: key in $PLANS_KEY (or the file named by $PLANS_KEY_FILE,
// default ~/.claude/plans-site/key). It never touches the clone's working tree and never force-pushes.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadKey, addReply } from './push-plan.mjs'

const repo = process.env.PLANS_REPO || dirname(fileURLToPath(import.meta.url))
const [name, msgId, ...rest] = process.argv.slice(2)
const text = rest.join(' ').trim()
if (!name || !/^[A-Za-z0-9_-]{1,40}$/.test(name) || !msgId || !text) {
  console.error('usage: node reply.mjs <name> <message-id> "<text>"')
  process.exit(2)
}
try {
  const { result, known } = await addReply({ repo, key: await loadKey(), name, msgId, text, log: m => console.log(m) })
  if (!known) console.log(`note: ${msgId} is not in ${name}'s thread (yet); the reply is stored anyway`)
  console.log(result === 'pushed' ? 'replied' : result)
} catch (e) { console.error('reply:', e.stderr?.toString?.() || e.message); process.exit(1) }
