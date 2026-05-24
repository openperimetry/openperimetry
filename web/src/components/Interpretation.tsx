import { useState } from 'react'
import type { TestPoint, StimulusKey, CalibrationData, TestResult } from '../types'
import { classifyFieldLoss, expectedNormalArea, type FieldSeverity } from '../clinicalClassifications'
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
  critical: 'text-red-400',
  warning: 'text-orange-400',
  caution: 'text-yellow-400',
  info: 'text-blue-400',
  ok: 'text-green-400',
  muted: 'text-gray-500',
}

const TONE_CARD_BG: Record<Tone, string> = {
  critical: 'bg-red-500/10 border-red-500/30',
  warning: 'bg-orange-500/10 border-orange-500/30',
  caution: 'bg-yellow-500/10 border-yellow-500/30',
  info: 'bg-blue-500/10 border-blue-500/30',
  ok: 'bg-green-500/10 border-green-500/30',
  muted: 'bg-gray-500/10 border-gray-500/30',
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
    color: 'text-red-400',
    bgColor: 'bg-red-500/10 border-red-500/30',
    description:
      'Less than ~5% of the testable field is detected. This indicates a tiny central island of vision remaining. Daily activities and mobility are severely affected.',
  },
  severe: {
    color: 'text-red-400',
    bgColor: 'bg-red-500/10 border-red-500/30',
    description:
      'Roughly 5–20% of the testable field is detected. This degree of constriction often meets criteria for legal blindness when the central field is ≤ 20° diameter. Significant mobility challenges are likely.',
  },
  moderate: {
    color: 'text-orange-400',
    bgColor: 'bg-orange-500/10 border-orange-500/30',
    description:
      'Roughly 20–45% of the testable field is detected. Peripheral awareness is reduced. Night vision and navigation in unfamiliar environments may be affected.',
  },
  mild: {
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500/10 border-yellow-500/30',
    description:
      'Roughly 45–70% of the testable field is detected. Some peripheral loss is present but central vision is well preserved. You may notice difficulty in dim lighting.',
  },
  borderline: {
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10 border-blue-500/30',
    description:
      'Roughly 70–85% of the testable field is detected. The field is near-normal with possible early constriction, though this may also reflect normal variation or test conditions.',
  },
  normal: {
    color: 'text-green-400',
    bgColor: 'bg-green-500/10 border-green-500/30',
    description:
      'More than ~85% of the testable field is detected — within normal limits for the tested range. Note that a screen-based test cannot cover the full clinical field; a clinical Goldmann test assesses out to 90°.',
  },
}

/**
 * Classify the OVERALL constriction severity of the field. Always based on
 * the III4e fraction of the testable area — even when a ring scotoma or
 * vertical asymmetry is present. Those patterns are reported separately via
 * `detectFieldPatterns` so a user with, e.g., early-RP constriction *plus*
 * a ring scotoma sees both findings rather than having one hide the other.
 */
function classifyField(
  iii4eArea: number,
  maxEccentricityDeg: number,
  calibration?: CalibrationData,
): Classification {
  const fraction = iii4eArea / expectedNormalArea(maxEccentricityDeg, calibration)
  const band = classifyFieldLoss(fraction)
  const theme = CLASSIFICATION_THEMES[band.severity]
  return { label: band.label, color: theme.color, bgColor: theme.bgColor, description: theme.description }
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
}

export function Interpretation({ points, areas, maxEccentricityDeg, calibration, reliabilityIndices }: Props) {
  const [expanded, setExpanded] = useState(false)

  const iii4eArea = areas['III4e']
  const classification = iii4eArea != null ? classifyField(iii4eArea, maxEccentricityDeg, calibration) : null
  const patterns = detectFieldPatterns(points, areas)
  const gradient = analyzeSensitivityGradient(areas)
  const centralIsland = analyzeCentralIsland(areas)
  const rpFindings = detectRPFindings(points, areas, maxEccentricityDeg, calibration).filter(f => f.present)
  const anomalies = detectAnomalies(points, areas)
  const reliability = computeReliability(points, areas)
  const reliabilityIdx = computeReliabilityIndices({ reliabilityIndices })
  const expectedArea = expectedNormalArea(maxEccentricityDeg, calibration)

  return (
    <div className="space-y-3">
      {/* Toggle button */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left px-4 py-3 bg-gray-900 hover:bg-gray-800 rounded-xl border border-gray-800 transition-colors flex items-center justify-between"
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
          {/* Reliability badge */}
          <span className={`text-xs ${reliability.color} font-mono`}>
            Reliability: {reliability.score}%
          </span>
          <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 px-1">
          {/* Reliability score */}
          <div className="bg-gray-900 rounded-xl p-4 space-y-3 border border-gray-800">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-300">Test reliability</h3>
              <span className={`text-lg font-mono font-semibold ${reliability.color}`}>
                {reliability.score}/100
              </span>
            </div>
            <div className="w-full h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${reliability.score}%`,
                  backgroundColor:
                    reliability.score >= 85
                      ? '#4ade80'
                      : reliability.score >= 65
                        ? '#facc15'
                        : reliability.score >= 40
                          ? '#fb923c'
                          : '#f87171',
                }}
              />
            </div>
            {reliability.factors.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {reliability.factors.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="text-red-400 font-mono shrink-0">-{f.penalty}</span>
                    <span className="text-gray-400">{f.detail}</span>
                  </div>
                ))}
              </div>
            )}
            {reliability.factors.length === 0 && (
              <p className="text-xs text-gray-500">No reliability issues detected.</p>
            )}
          </div>

          {/* Fixation Accuracy + False-Positive Response Rate — reference ranges
              from Dzwiniel et al., PLoS ONE 2017 (n=21 healthy controls). Only
              shown when the test recorded catch trials. */}
          {reliabilityIdx.fa && (
            <div className="bg-gray-900 rounded-xl p-4 space-y-3 border border-gray-800">
              <h3 className="text-sm font-medium text-gray-300">Reliability indices</h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="text-gray-300 font-medium">Fixation accuracy (FA)</div>
                    <div className="text-gray-500">
                      {reliabilityIdx.fa.correct}/{reliabilityIdx.fa.presented} catch trials correctly ignored · normal {RELIABILITY_REFERENCE_RANGES.faPercent.min}–{RELIABILITY_REFERENCE_RANGES.faPercent.max}%
                    </div>
                    <div
                      className={
                        reliabilityIdx.fa.band === 'normal'
                          ? 'text-green-400'
                          : reliabilityIdx.fa.band === 'borderline'
                            ? 'text-yellow-400'
                            : 'text-red-400'
                      }
                    >
                      {reliabilityIdx.fa.bandLabel}
                    </div>
                  </div>
                  <div
                    className={`font-mono text-lg shrink-0 ${
                      reliabilityIdx.fa.band === 'normal'
                        ? 'text-green-400'
                        : reliabilityIdx.fa.band === 'borderline'
                          ? 'text-yellow-400'
                          : 'text-red-400'
                    }`}
                  >
                    {reliabilityIdx.fa.percent.toFixed(0)}%
                  </div>
                </div>
                {reliabilityIdx.fprr && (
                  <div className="flex items-start justify-between gap-3 pt-2 border-t border-gray-800">
                    <div className="flex-1">
                      <div className="text-gray-300 font-medium">False-positive response rate (FPRR)</div>
                      <div className="text-gray-500">
                        {reliabilityIdx.fprr.falsePositives}/{reliabilityIdx.fprr.total} responses were false positives · normal {RELIABILITY_REFERENCE_RANGES.fprrPercent.min}–{RELIABILITY_REFERENCE_RANGES.fprrPercent.max}%
                      </div>
                      <div
                        className={
                          reliabilityIdx.fprr.band === 'normal'
                            ? 'text-green-400'
                            : reliabilityIdx.fprr.band === 'elevated'
                              ? 'text-yellow-400'
                              : 'text-red-400'
                        }
                      >
                        {reliabilityIdx.fprr.bandLabel}
                      </div>
                    </div>
                    <div
                      className={`font-mono text-lg shrink-0 ${
                        reliabilityIdx.fprr.band === 'normal'
                          ? 'text-green-400'
                          : reliabilityIdx.fprr.band === 'elevated'
                            ? 'text-yellow-400'
                            : 'text-red-400'
                      }`}
                    >
                      {reliabilityIdx.fprr.percent.toFixed(1)}%
                    </div>
                  </div>
                )}
                <p className="text-gray-600 text-[10px] pt-1">
                  Reference ranges: {RELIABILITY_REFERENCE_RANGES.citation}
                </p>
              </div>
            </div>
          )}

          {/* Field classification — the headline severity tier. Additive
              pattern modifiers (ring scotoma, asymmetry) are rendered as
              separate cards below so they don't hide the base severity. */}
          {classification && (
            <div className={`rounded-xl p-4 border ${classification.bgColor}`}>
              <h3 className={`text-sm font-medium ${classification.color} mb-2`}>
                {classification.label}
              </h3>
              <p className="text-xs text-gray-300 leading-relaxed">{classification.description}</p>
              {iii4eArea != null && (
                <p className="text-xs text-gray-500 mt-2">
                  III4e isopter: {iii4eArea.toFixed(0)} deg² (~{((iii4eArea / expectedArea) * 100).toFixed(0)}% of testable area, equivalent radius ~{Math.sqrt(iii4eArea / Math.PI).toFixed(1)}°)
                </p>
              )}
            </div>
          )}

          {/* Pattern modifiers — ring scotoma, asymmetry, etc. These can
              coexist with any severity tier and are reported additively. */}
          {patterns.map(p => (
            <div key={p.key} className={`rounded-xl p-4 border ${TONE_CARD_BG[p.tone]}`}>
              <h3 className={`text-sm font-medium ${TONE_TEXT[p.tone]} mb-2`}>{p.label}</h3>
              <p className="text-xs text-gray-300 leading-relaxed">{p.description}</p>
            </div>
          ))}

          {/* Sensitivity gradient */}
          {gradient && (
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h3 className={`text-sm font-medium ${TONE_TEXT[gradient.tone]} mb-2`}>{gradient.label}</h3>
              <p className="text-xs text-gray-300 leading-relaxed">{gradient.description}</p>
            </div>
          )}

          {/* Central island */}
          {centralIsland && (
            <div className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <h3 className={`text-sm font-medium ${TONE_TEXT[centralIsland.tone]} mb-2`}>
                {centralIsland.label}
              </h3>
              <p className="text-xs text-gray-300 leading-relaxed">{centralIsland.description}</p>
            </div>
          )}

          {/* RP-specific findings */}
          {rpFindings.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider px-1">
                RP indicators
              </h3>
              {rpFindings.map((f, i) => (
                <div
                  key={i}
                  className="bg-gray-900 rounded-xl p-4 border border-gray-800"
                >
                  <h4 className={`text-sm font-medium ${TONE_TEXT[f.tone]} mb-1`}>{f.label}</h4>
                  <p className="text-xs text-gray-300 leading-relaxed">{f.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Anomalies */}
          {anomalies.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider px-1">
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
                  <p className="text-xs text-gray-300 leading-relaxed">{a.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <p className="text-xs text-gray-600 leading-relaxed px-1">
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
