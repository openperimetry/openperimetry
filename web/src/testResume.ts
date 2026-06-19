/**
 * Cross-reload resume for an in-progress test.
 *
 * The exam state (staircases, queue, results, counters) lived only in
 * component refs, so ANY teardown — a reflexive Cmd+R on the fullscreen
 * black screen, an accidental nav, the OS discarding a backgrounded mobile
 * tab — destroyed 7–8 minutes of work with no recovery. A user who got most
 * of the way through then rationally abandons rather than redo.
 *
 * We snapshot a serialisable copy to `sessionStorage` on every checkpoint
 * (and on the pagehide teardown), keyed by eye, and offer "Resume your
 * test?" on the next mount. `sessionStorage` (not `localStorage`) is
 * deliberate: it survives reload and bfcache restore but is scoped to the
 * tab, so a stale snapshot can't leak into a deliberately-fresh later
 * session, and it auto-clears when the tab closes.
 *
 * Storage I/O is injectable so the serialisation can be unit-tested under
 * the `node` test environment (which has no `sessionStorage`).
 */

import type { StaircaseState } from './staircase'

const RESUME_PREFIX = 'vfc.resume.'
/** Bump when the snapshot shape changes incompatibly — old snapshots are
 *  then ignored rather than mis-deserialised. */
export const RESUME_VERSION = 2
/** A snapshot older than this is discarded: a long gap (a call, sleep)
 *  changes light adaptation, so resuming mid-exam would taint the data. */
export const RESUME_MAX_AGE_MS = 30 * 60 * 1000

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function defaultStorage(): StorageLike | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage
  } catch { /* sessionStorage can throw in private mode / sandboxes */ }
  return null
}

export interface ResumeEnvelope<T> {
  version: number
  savedAt: number
  payload: T
}

/** Serialise a staircase map for storage (`Map` is not JSON-able). */
export function serializeStaircases(
  map: Map<string, StaircaseState>,
): Array<[string, StaircaseState]> {
  return Array.from(map.entries())
}

/** Rebuild the staircase map from its serialised entries. */
export function deserializeStaircases(
  entries: Array<[string, StaircaseState]>,
): Map<string, StaircaseState> {
  return new Map(entries)
}

export function saveResumeSnapshot<T>(
  key: string,
  payload: T,
  now: number = Date.now(),
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    const env: ResumeEnvelope<T> = { version: RESUME_VERSION, savedAt: now, payload }
    storage.setItem(RESUME_PREFIX + key, JSON.stringify(env))
  } catch { /* quota / serialisation failure — resume is best-effort */ }
}

export function loadResumeSnapshot<T>(
  key: string,
  now: number = Date.now(),
  maxAgeMs: number = RESUME_MAX_AGE_MS,
  storage: StorageLike | null = defaultStorage(),
): T | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(RESUME_PREFIX + key)
    if (!raw) return null
    const env = JSON.parse(raw) as ResumeEnvelope<T>
    if (!env || env.version !== RESUME_VERSION || typeof env.savedAt !== 'number') return null
    if (now - env.savedAt > maxAgeMs) {
      clearResumeSnapshot(key, storage)
      return null
    }
    return env.payload
  } catch {
    return null
  }
}

export function clearResumeSnapshot(
  key: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(RESUME_PREFIX + key)
  } catch { /* ignore */ }
}

/** One-time "the user has done the press-when-seen practice" flag. Stored in
 *  localStorage (not sessionStorage) so it survives across sessions — once
 *  someone has learned the response, every later run on this device skips
 *  the warm-up. Shared by Static and Goldmann: the core mechanic is the
 *  same ("press the instant you see the dot"), so learning it once is
 *  enough. */
const PRACTICE_DONE_KEY = 'vfc.practiceDone'

export function isPracticeDone(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(PRACTICE_DONE_KEY) === '1'
  } catch {
    return false
  }
}

export function markPracticeDone(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(PRACTICE_DONE_KEY, '1')
  } catch { /* ignore */ }
}

/** Build the per-eye storage key. Eye is enough to keep left/right runs from
 *  colliding; calibration/grid/speed validity is checked inside the payload
 *  so a recalibration or settings change invalidates an otherwise-fresh
 *  snapshot. */
export function resumeKey(testType: string, eye: string): string {
  return `${testType}.${eye}`
}
