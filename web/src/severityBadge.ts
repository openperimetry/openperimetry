/** Tailwind classes for a scenario severity badge.
 *  Mirrors the colour bands used across the clinical scenario UI. */
export function severityBadgeClass(severity: string): string {
  const tone =
    severity === 'Normal' ? 'bg-green-500/15 text-green-400' :
    severity === 'Mild' ? 'bg-yellow-500/15 text-yellow-400' :
    severity.startsWith('Moderate') ? 'bg-orange-500/15 text-orange-400' :
    severity === 'Severe' ? 'bg-red-500/15 text-red-400' :
    'bg-red-600/15 text-red-500'
  return `px-3 py-1 rounded-full text-xs font-medium shrink-0 ${tone}`
}
