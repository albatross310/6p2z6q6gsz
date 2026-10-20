#!/usr/bin/env node
// Read every agent's plan from the Plans site, decrypted, to stdout. Needs the same key as push-plan.mjs.
//
//   node read-plans.mjs            every plan, whole
//   node read-plans.mjs --live     only each plan's "## Live" sections (tracing a new bug to a recent change)
//
// Prints plaintext to the terminal only; never write its output into this repo.
import { readFile } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { loadKey } from './push-plan.mjs'

const dir = dirname(fileURLToPath(import.meta.url))
try { execFileSync('git', ['-C', dir, 'pull', '-q', '--ff-only'], { stdio: 'ignore' }) } catch { /* read what is here */ }
const key = await webcrypto.subtle.importKey('raw', await loadKey(), 'AES-GCM', false, ['decrypt'])
const dec = async (f) => {
  const b = await readFile(join(dir, f))
  return JSON.parse(new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12))))
}
const liveOnly = process.argv.includes('--live')
const { agents } = await dec('plans/index.enc')
for (const a of agents) {
  const p = await dec(`plans/${a.id}.enc`)
  const text = liveOnly ? p.text.split(/\n(?=## )/).filter((s) => /^## Live/i.test(s)).join('\n') : p.text
  console.log(`==================== ${p.name} · updated ${new Date(p.updatedMs).toISOString().slice(0, 16)}Z ====================\n${text.trim()}\n`)
}
