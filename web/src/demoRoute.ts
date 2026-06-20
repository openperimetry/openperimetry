/** The hash segment that opens the demo section (`#demos`). */
export const DEMO_HASH = 'demos'

/** Normalize a `location.hash` and split it into the route head and remainder.
 *  '#demos/early-rp' → { head: 'demos', rest: 'early-rp' }
 *  '#demos'          → { head: 'demos', rest: '' }
 *  ''                → { head: '', rest: '' } */
export function splitHash(hash: string): { head: string; rest: string } {
  const key = hash.replace(/^#\/?/, '').trim().toLowerCase()
  const slash = key.indexOf('/')
  if (slash === -1) return { head: key, rest: '' }
  return { head: key.slice(0, slash), rest: key.slice(slash + 1) }
}

/** Scenario id from a hash, or null when it isn't a demo-scenario hash. */
export function demoScenarioFromHash(hash: string): string | null {
  const { head, rest } = splitHash(hash)
  if (head !== DEMO_HASH) return null
  return rest || null
}

/** Which test result a demo scenario page is showing. */
export type DemoMode = 'goldmann' | 'static'

/** Parse a hash into the demo scenario id and mode.
 *  '#demos/early-rp'        → { id: 'early-rp', mode: 'goldmann' }
 *  '#demos/early-rp/static' → { id: 'early-rp', mode: 'static' }
 *  '#demos' / non-demo      → { id: null, mode: 'goldmann' } */
export function demoTargetFromHash(hash: string): { id: string | null; mode: DemoMode } {
  const { head, rest } = splitHash(hash)
  if (head !== DEMO_HASH || !rest) return { id: null, mode: 'goldmann' }
  const segs = rest.split('/')
  const id = segs[0] || null
  const mode: DemoMode = segs.length > 1 && segs[segs.length - 1] === 'static' ? 'static' : 'goldmann'
  return { id, mode }
}

/** Hash (no leading '#') for the demo picker (null id) or a scenario+mode. */
export function demoHash(scenarioId: string | null, mode: DemoMode = 'goldmann'): string {
  if (!scenarioId) return DEMO_HASH
  return mode === 'static' ? `${DEMO_HASH}/${scenarioId}/static` : `${DEMO_HASH}/${scenarioId}`
}

/** Neighbour scenario id in the given direction, wrapping around the list.
 *  Returns null only when `current` isn't in `ids`. */
export function adjacentScenarioId(ids: string[], current: string, dir: -1 | 1): string | null {
  const i = ids.indexOf(current)
  if (i === -1) return null
  const n = ids.length
  return ids[(i + dir + n) % n]
}
