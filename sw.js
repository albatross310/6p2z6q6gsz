// Shell: served from cache at once, refreshed in the background. plans/*.enc: always the network,
// falling back to the last copy seen (marked with x-plans-cache: 1 so the page can say it is offline).
const SHELL = 'plans-shell-v2', DATA = 'plans-data'
const FILES = ['./', 'manifest.webmanifest', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting() })
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (/\/plans\/[^/]+\.enc$/.test(url.pathname)) {
    const slot = url.pathname.split('/').slice(-2).join('/')
    e.respondWith((async () => {
      const c = await caches.open(DATA)
      try {
        const r = await fetch(e.request, { cache: 'no-store' })
        if (r.ok) { await c.put(slot, r.clone()); return r }
        throw new Error(r.status)
      } catch (err) {
        const old = await c.match(slot)
        if (!old) throw err
        const h = new Headers(old.headers); h.set('x-plans-cache', '1')
        return new Response(await old.arrayBuffer(), { status: 200, headers: h })
      }
    })())
    return
  }
  const scope = new URL(self.registration.scope).pathname
  const key = e.request.mode === 'navigate' || url.pathname === scope + 'index.html' ? './' : e.request
  e.respondWith((async () => {
    const c = await caches.open(SHELL)
    const hit = await c.match(key, { ignoreSearch: true })
    const net = fetch(e.request).then(r => { if (r.ok) c.put(key, r.clone()); return r }).catch(() => hit)
    if (hit) { e.waitUntil(net); return hit }
    return net
  })())
})
