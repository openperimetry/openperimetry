export function isPhoneLikeDevice(): boolean {
  if (typeof navigator === 'undefined') return false

  const userAgent = navigator.userAgent ?? ''
  const maxTouchPoints = navigator.maxTouchPoints ?? 0
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
  const iPadDesktopUa = navigator.platform === 'MacIntel' && maxTouchPoints > 1

  if (uaMobile || iPadDesktopUa) return true

  if (typeof window === 'undefined') return false

  // Size fallback for phones whose UA we don't recognise. A small window on
  // its own isn't enough: a laptop browser narrowed to a sliver (or with
  // devtools docked) also matches, which is how Phone VR leaked onto laptops.
  // Gate it behind a genuine touch device — coarse pointer, can't hover.
  const touchPrimary = maxTouchPoints > 0
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
    && window.matchMedia('(hover: none)').matches
  if (!touchPrimary) return false

  const narrowSide = Math.min(window.innerWidth, window.innerHeight)
  const longSide = Math.max(window.innerWidth, window.innerHeight)

  return narrowSide <= 520 && longSide <= 950
}
