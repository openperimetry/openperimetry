import { useState } from 'react'
import type { TestPoint, StimulusKey, CalibrationData, TestResult } from '../types'
import { STIMULI } from '../types'
import { scoreField, type FieldSeverity } from '../clinicalClassifications'
import { SeverityContinuum } from './SeverityContinuum'
import {
  analyzeSensitivityGradient,
  analyzeCentralIsland,
  detectFieldPatterns,
  detectRPFindings,
  detectAnomalies,
  type Tone,
  type AnomalyIcon,
} from '../fieldAnalysis'
import { computeReliability } from '../reliabilityScore'
import { computeReliabilityIndices } from '../reliabilityIndices'
import { RELIABILITY_REFERENCE_RANGES } from '../testDefaults'

// Map tone keys emitted by fieldAnalysis.ts to Tailwind classes. The
// PDF renderer has its own RGB mapping — both stay in sync because the
// shared module emits the tone, not the colour.
const TONE_TEXT: Record<Tone, string> = {
  critical: 'text-red-700 dark:text-red-200',
  warning: 'text-orange-700 dark:text-orange-200',
  caution: 'text-amber-700 dark:text-amber-200',
  info: 'text-blue-700 dark:text-blue-200',
  ok: 'text-green-700 dark:text-green-200',
  muted: 'text-muted',
}

const TONE_CARD_BG: Record<Tone, string> = {
  critical: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60',
  warning: 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-900/60',
  caution: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60',
  info: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/60',
  ok: 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-900/60',
  muted: 'bg-subtle border-line',
}

/** Anomaly glyph prefix — mirrors the PDF renderer so both surfaces
 *  carry the same ℹ/⚠/✕ affordance without duplicating the mapping. */
const ANOMALY_GLYPH: Record<AnomalyIcon, string> = {
  info: 'ℹ',
  warning: '⚠',
  error: '✕',
}

// ── Field classification thresholds (percent of testable area) ──
// A screen-based test cannot reach the full clinical 90° field. We classify
// the III4e isopter as a percentage of the area a healthy eye would cover
// within the *actual* screen-bounded testable region, so the same retina
// gets the same verdict on a phone vs a desktop monitor regardless of
// aspect ratio or fixation offset.

interface Classification {
  label: string
  color: string     // tailwind text color
  bgColor: string   // tailwind bg color
  description: string
}

/** Tailwind theme + long-form description per severity band. Labels and
 *  thresholds come from ../clinicalClassifications so both the in-app
 *  panel and the PDF export stay in lockstep on clinical grading. */
const CLASSIFICATION_THEMES: Record<FieldSeverity, { color: string; bgColor: string; description: string }> = {
  'very-severe': {
    color: 'text-red-700 dark:text-red-200',
    bgColor: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60',
    description:
      'Only a tiny central island of vision remains across the tested targets. Daily activities and mobility are severely affected.',
  },
  severe: {
    color: 'text-red-700 dark:text-red-200',
    bgColor: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900/60',
    description:
      'The field is severely constricted — often meeting legal-blindness criteria when the central field is ≤ 20° diameter. Significant mobility challenges are likely.',
  },
  moderate: {
    color: 'text-orange-700 dark:text-orange-200',
    bgColor: 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-900/60',
    description:
      'Peripheral awareness is moderately reduced. Night vision and navigation in unfamiliar environments may be affected, while central vision is comparatively better preserved.',
  },
  mild: {
    color: 'text-amber-700 dark:text-amber-200',
    bgColor: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/60',
    description:
      'Some peripheral loss is present but central vision is well preserved. You may notice difficulty in dim lighting. This is the early-change range.',
  },
  borderline: {
    color: 'text-blue-700 dark:text-blue-200',
    bgColor: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/60',
    description:
      'The field is near-normal with possible early constriction, though this may also reflect normal variation or test conditions.',
  },
  normal: {
    color: 'text-green-700 dark:text-green-200',
    bgColor: 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-900/60',
    description:
      'Within normal limits for the tested range. Note that a screen-based test cannot cover the full clinical field; a clinical Goldmann test assesses out to 90°.',
  },
}

/**
 * The OVERALL constriction severity is the base STAGE from the multi-isopter
 * field score (scoreField) — robust because it averages every measured isopter
 * rather than hanging the whole grade on III4e. Pattern (ring scotoma,
 * asymmetry) is orthogonal and reported separately via `detectFieldPatterns`,
 * so a user with, e.g., moderate constriction *plus* a ring scotoma sees the
 * stage AND the modifier rather than one hiding the other.
 */
function themeForSeverity(severity: FieldSeverity, label: string): Classification {
  const theme = CLASSIFICATION_THEMES[severity]
  return { label, color: theme.color, bgColor: theme.bgColor, description: theme.description }
}

// ── Main component ──
interface Props {
  points: TestPoint[]
  areas: Partial<Record<StimulusKey, number>>
  maxEccentricityDeg: number
  /** Full calibration from the test run. When provided, classification
   *  uses the actual screen rectangle area as the "normal" reference
   *  instead of the circular π × maxEcc² approximation. Optional so
   *  legacy/demo call sites still compile. */
  calibration?: CalibrationData
  /** Raw catch-trial + response counters from the test run, used to render
   *  Fixation Accuracy and False-Positive Response Rate. Absent on demo
   *  and legacy results — the section is simply hidden in that case. */
  reliabilityIndices?: TestResult['reliabilityIndices']
  /** Reliability scoring is clinician/admin-only. Regular users still
   *  see the field interpretation, but not scores or trial-quality
   *  counters that can be misleading without clinical context. */
  showReliability?: boolean
}

export function Interpretation({
  points,
  areas,
  maxEccentricityDeg,
  calibration,
  reliabilityIndices,
  showReliability = false,
}: Props) {
  const [expanded, setExpanded] = useState(false)

  // Multi-isopter field score → base stage + 0–100 field score. Robust to one
  // atypically-low isopter (inferior defect, VR periphery collapse).
  const fieldScore = scoreField(areas, maxEccentricityDeg, calibration)
  const classification = fieldScore ? themeForSeverity(fieldScore.band.severity, fieldScore.band.label) : null
  const patterns = detectFieldPatterns(points, areas)
  const gradient = analyzeSensitivityGradient(areas)
  const centralIsland = analyzeCentralIsland(areas)
  const rpFindings = detectRPFindings(points, areas, maxEccentricityDeg, calibration, fieldScore).filter(f => f.present)
  const anomalies = detectAnomalies(points, areas)
  const reliability = showReliability ? computeReliability(points, areas) : null
  const reliabilityIdx = showReliability ? computeReliabilityIndices({ reliabilityIndices }) : { fa: null, fprr: null }

  return (
    <div className="space-y-3">
      {/* Toggle button */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left px-4 py-3 bg-surface hover:bg-subtle rounded-xl border border-line transition-colors flex items-center justify-between"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium">Interpretation</span>
          {classification && (
            <span className={`text-xs ${classification.color}`}>{classification.label}</span>
          )}
          {patterns.map(p => (
            <span
              key={p.key}
              className={`text-xs px-1.5 py-0.5 rounded border ${TONE_CARD_BG[p.tone]} ${TONE_TEXT[p.tone]}`}
            >
              {p.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {reliability && (
            <span className={`text-xs ${reliability.color} font-mono`}>
              Reliability: {reliability.score}%
            </span>
          )}
          <span className="text-muted text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 px-1">
          {reliability && (
            <div className="bg-surface rounded-xl p-4 space-y-3 border border-line">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-body">Test reliability</h3>
                <span className={`text-lg font-mono font-semibold ${reliability.color}`}>
                  {reliability.score}/100
                </span>
              </div>
              <div className="w-full h-1.5 bg-subtle-2 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${reliability.score}%`,
                    backgroundColor:
                      reliability.score >= 85
                        ? '#16a34a'
                        : reliability.score >= 65
                          ? '#ca8a04'
                          : reliability.score >= 40
                            ? '#ea580c'
                            : '#dc2626',
                  }}
                />
              </div>
              {reliability.factors.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {reliability.factors.map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <span className="text-red-700 dark:text-red-300 font-mono shrink-0">-{f.penalty}</span>
                      <span className="text-muted">{f.detail}</span>
                    </div>
                  ))}
                </div>
              )}
              {reliability.factors.length === 0 && (
                <p className="text-xs text-muted">No reliability issues detected.</p>
              )}
            </div>
            )}

          {/* Fixation Accuracy + False-Positive Response Rate — reference ranges
              from Dzwiniel et al., PLoS ONE 2017 (n=21 healthy controls). Only
              shown when the test recorded catch trials. */}
          {reliabilityIdx.fa && (
            <div className="bg-surface rounded-xl p-4 space-y-3 border border-line">
              <h3 className="text-sm font-medium text-body">Reliability indices</h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="text-body font-medium">Fixation accuracy (FA)</div>
                    <div className="text-muted">
                      {reliabilityIdx.fa.correct}/{reliabilityIdx.fa.presented} catch trials correctly ignored · normal {RELIABILITY_REFERENCE_RANGES.faPercent.min}–{RELIABILITY_REFERENCE_RANGES.faPercent.max}%
                    </div>
                    <div
                      className={
                        reliabilityIdx.fa.band === 'normal'
                          ? 'text-green-700 dark:text-green-300'
                          : reliabilityIdx.fa.band === 'borderline'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-red-700 dark:text-red-300'
                      }
                    >
                      {reliabilityIdx.fa.bandLabel}
                    </div>
                  </div>
                  <div
                    className={`font-mono text-lg shrink-0 ${
                      reliabilityIdx.fa.band === 'normal'
                        ? 'text-green-700 dark:text-green-300'
                        : reliabilityIdx.fa.band === 'borderline'
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-red-700 dark:text-red-300'
                    }`}
                  >
                    {reliabilityIdx.fa.percent.toFixed(0)}%
                  </div>
                </div>
                {reliabilityIdx.fprr && (
                  <div className="flex items-start justify-between gap-3 pt-2 border-t border-line">
                    <div className="flex-1">
                      <div className="text-body font-medium">False-positive response rate (FPRR)</div>
                      <div className="text-muted">
                        {reliabilityIdx.fprr.falsePositives}/{reliabilityIdx.fprr.total} responses were false positives · normal {RELIABILITY_REFERENCE_RANGES.fprrPercent.min}–{RELIABILITY_REFERENCE_RANGES.fprrPercent.max}%
                      </div>
                      <div
                        className={
                          reliabilityIdx.fprr.band === 'normal'
                            ? 'text-green-700 dark:text-green-300'
                            : reliabilityIdx.fprr.band === 'elevated'
                              ? 'text-amber-700 dark:text-amber-300'
                              : 'text-red-700 dark:text-red-300'
                        }
                      >
                        {reliabilityIdx.fprr.bandLabel}
                      </div>
                    </div>
                    <div
                      className={`font-mono text-lg shrink-0 ${
                        reliabilityIdx.fprr.band === 'normal'
                          ? 'text-green-700 dark:text-green-300'
                          : reliabilityIdx.fprr.band === 'elevated'
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-red-700 dark:text-red-300'
                      }`}
                    >
                      {reliabilityIdx.fprr.percent.toFixed(1)}%
                    </div>
                  </div>
                )}
                <p className="text-muted text-[10px] pt-1">
                  Reference ranges: {RELIABILITY_REFERENCE_RANGES.citation}
                </p>
              </div>
            </div>
          )}

          {/* Field classification — the headline severity tier. Additive
              pattern modifiers (ring scotoma, asymmetry) are rendered as
              separate cards below so they don't hide the base severity. */}
          {classification && fieldScore && (
            <div className={`rounded-xl p-4 border ${classification.bgColor}`}>
              <h3 className={`text-sm font-medium ${classification.color} mb-2`}>
                {classification.label}
                {patterns.length > 0 && (
                  <span className="text-body font-normal"> · {patterns.map(p => p.label.toLowerCase()).join(' · ')}</span>
                )}
              </h3>
              <p className="text-xs text-body leading-relaxed">{classification.description}</p>
              {/* Field score on the base-stage continuum */}
              <div className="mt-3">
                <SeverityContinuum score={fieldScore.score} bandLabel={fieldScore.band.label} severity={fieldScore.band.severity} />
              </div>
              {/* Per-isopter breakdown — the pattern the overall score averages
                  over (e.g. preserved V4e with reduced inner isopters in RP). */}
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1">
                {fieldScore.perIsopter.map(p => (
                  <span key={p.key} className="text-[11px] text-body inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: STIMULI[p.key].color }} />
                    <span className="text-ink">{p.key}</span>
                    <span className="font-mono tnum">{(p.fraction * 100).toFixed(0)}%</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Pattern modifiers — ring scotoma, asymmetry, etc. These can
              coexist with any severity tier and are reported additively. */}
          {patterns.map(p => (
            <div key={p.key} className={`rounded-xl p-4 border ${TONE_CARD_BG[p.tone]}`}>
              <h3 className={`text-sm font-medium ${TONE_TEXT[p.tone]} mb-2`}>{p.label}</h3>
              <p className="text-xs text-body leading-relaxed">{p.description}</p>
            </div>
          ))}

          {/* Sensitivity gradient */}
          {gradient && (
            <div className="bg-surface rounded-xl p-4 border border-line">
              <h3 className={`text-sm font-medium ${TONE_TEXT[gradient.tone]} mb-2`}>{gradient.label}</h3>
              <p className="text-xs text-body leading-relaxed">{gradient.description}</p>
            </div>
          )}

          {/* Central island */}
          {centralIsland && (
            <div className="bg-surface rounded-xl p-4 border border-line">
              <h3 className={`text-sm font-medium ${TONE_TEXT[centralIsland.tone]} mb-2`}>
                {centralIsland.label}
              </h3>
              <p className="text-xs text-body leading-relaxed">{centralIsland.description}</p>
            </div>
          )}

          {/* RP-specific findings */}
          {rpFindings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted uppercase tracking-wider px-1">
                RP indicators
              </h3>
              {rpFindings.map((f, i) => (
                <div
                  key={i}
                  className="bg-surface rounded-xl p-4 border border-line"
                >
                  <h4 className={`text-sm font-medium ${TONE_TEXT[f.tone]} mb-1`}>{f.label}</h4>
                  <p className="text-xs text-body leading-relaxed">{f.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Anomalies */}
          {anomalies.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-muted uppercase tracking-wider px-1">
                Anomalies detected
              </h3>
              {anomalies.map((a, i) => (
                <div
                  key={i}
                  className={`rounded-xl p-4 border ${TONE_CARD_BG[a.tone]}`}
                >
                  <h4 className={`text-sm font-medium mb-1 ${TONE_TEXT[a.tone]}`}>
                    {ANOMALY_GLYPH[a.icon]} {a.label}
                  </h4>
                  <p className="text-xs text-body leading-relaxed">{a.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <p className="text-xs text-muted leading-relaxed px-1">
            This tool has not been validated against a clinical perimeter. This interpretation
            is generated automatically for self-monitoring purposes only. Results may differ
            from clinical perimetry due to screen limitations, uncontrolled viewing distance,
            and the absence of standardized testing conditions. Always consult your
            ophthalmologist for diagnosis and treatment decisions. Use this tool to notice
            changes in your own field — not as a reliable clinical indicator.
          </p>
        </div>
      )}
    </div>
  )
}
