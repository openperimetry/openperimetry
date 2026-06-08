export function isPhoneLikeDevice(): boolean {
  if (typeof navigator === 'undefined') return false

  const userAgent = navigator.userAgent ?? ''
  const maxTouchPoints = navigator.maxTouchPoints ?? 0
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
  const iPadDesktopUa = navigator.platform === 'MacIntel' && maxTouchPoints > 1

  if (uaMobile || iPadDesktopUa) return true

  if (typeof window === 'undefined') return false
  const narrowSide = Math.min(window.innerWidth, window.innerHeight)
  const longSide = Math.max(window.innerWidth, window.innerHeight)

  return narrowSide <= 520 && longSide <= 950
}
