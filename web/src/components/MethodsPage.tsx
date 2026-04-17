import { BackButton } from './AccessibleNav'
import { APP_NAME } from '../branding'
import { STIMULI, ISOPTER_ORDER } from '../types'
import {
  CATCH_TRIAL_EVERY_N,
  FIXATION_LOSS_ALERT_MS,
  FIXATION_LOSS_ALERT_MESSAGE,
  SPEED_PRESETS,
  RELIABILITY_REFERENCE_RANGES,
} from '../testDefaults'
import { blindspotLocation } from '../blindspot'

interface Props {
  onBack: () => void
}

interface Row {
  param: string
  value: string
  meaning: string
}

// Build stimulus rows dynamically from the STIMULI source — guarantees the
// page cannot drift from the code.
const STIMULI_MEANINGS: Record<string, string> = {
  'V4e':   'Largest, brightest stimulus. Maps the outermost isopter.',
  'III4e': 'Medium size, full brightness. Standard reference isopter for severity classification.',
  'III2e': 'Same size as III4e at ~1 log unit dimmer. Probes mid-peripheral sensitivity.',
  'I4e':   'Small bright stimulus. Detects small acuity-limited islands.',
  'I2e':   'Smallest dim stimulus. Maps the central island in advanced loss.',
}
function buildStimuliRows(): Row[] {
  return ISOPTER_ORDER.map((key) => {
    const def = STIMULI[key]
    const intensity = def.intensityFrac === 1 ? 'full' : def.intensityFrac.toFixed(2)
    return {
      param: def.label,
      value: `${def.sizeDeg}° · ${intensity}`,
      meaning: STIMULI_MEANINGS[key] ?? '',
    }
  })
}

// Build static-test timing rows dynamically from SPEED_PRESETS.
function buildSpeedPresetRows(): Row[] {
  const p = SPEED_PRESETS
  return [
    {
      param: 'Stimulus on (relaxed/normal/fast)',
      value: `${p.relaxed.stimulusMs} / ${p.normal.stimulusMs} / ${p.fast.stimulusMs} ms`,
      meaning: 'How long each dot is shown.',
    },
    {
      param: 'Response window (relaxed/normal/fast)',
      value: `${p.relaxed.responseMs} / ${p.normal.responseMs} / ${p.fast.responseMs} ms`,
      meaning: 'Time after stimulus offset still counted as a hit.',
    },
    {
      param: 'Inter-stimulus gap (relaxed/normal/fast)',
      value: `${p.relaxed.gapMinMs}–${p.relaxed.gapMaxMs} / ${p.normal.gapMinMs}–${p.normal.gapMaxMs} / ${p.fast.gapMinMs}–${p.fast.gapMaxMs} ms`,
      meaning: 'Random pause before the next dot (jittered to prevent anticipation).',
    },
  ]
}

function ParamTable({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
      <table className="w-full text-sm">
        <thead className="bg-white/[0.03] text-zinc-400 text-xs uppercase tracking-wider">
          <tr>
            <th className="text-left font-medium px-4 py-2">Parameter</th>
            <th className="text-left font-medium px-4 py-2 whitespace-nowrap">Value</th>
            <th className="text-left font-medium px-4 py-2">Meaning</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.05]">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-white/[0.02]">
              <td className="px-4 py-2 text-zinc-200 font-medium align-top">{r.param}</td>
              <td className="px-4 py-2 text-accent font-mono whitespace-nowrap align-top">{r.value}</td>
              <td className="px-4 py-2 text-zinc-400 align-top">{r.meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Section({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-heading font-bold">{title}</h2>
      {intro && <p className="text-zinc-400 text-sm leading-relaxed">{intro}</p>}
      <div className="space-y-4">{children}</div>
    </section>
  )
}

const STIMULI_ROWS: Row[] = buildStimuliRows()

const GOLDMANN_SPEED_ROWS: Row[] = [
  { param: 'Stimulus speed (normal)',     value: '3°/s',          meaning: 'Main outer-to-inner sweep velocity in normal mode.' },
  { param: 'Medium speed (normal)',       value: '2°/s',          meaning: 'Used when refining intermediate gradients.' },
  { param: 'Boundary speed (normal)',     value: '1.5°/s',        meaning: 'Slow boundary trace once a hit has been recorded.' },
  { param: 'Stimulus speed (fast)',       value: '6°/s',          meaning: 'Doubled velocity in Fast mode for ~5 min total time.' },
  { param: 'Medium speed (fast)',         value: '4°/s',          meaning: 'Fast-mode intermediate sweep.' },
  { param: 'Boundary speed (fast)',       value: '3°/s',          meaning: 'Fast-mode boundary refinement.' },
  { param: 'Pre-stimulus delay (normal)', value: '1200–2800 ms',  meaning: 'Random pause before stimulus onset to avoid anticipation.' },
  { param: 'Pre-stimulus delay (fast)',   value: '400–1000 ms',   meaning: 'Tighter randomized delay for fast pacing.' },
  { param: 'Min response time',           value: '150 ms',        meaning: 'Faster than this counts as a false start (physiologically impossible).' },
]

const GOLDMANN_LOGIC_ROWS: Row[] = [
  { param: 'Base meridians',     value: '12 × 30°',  meaning: 'Initial radial grid (every 30°) for outer isopters.' },
  { param: 'Fine meridians',     value: '24 × 15°',  meaning: 'Denser grid added for inner isopters where gradients are steep.' },
  { param: 'Boundary offset',    value: '8°',        meaning: 'Slow-trace passes start this far outside the previous detected eccentricity.' },
  { param: 'Adaptive threshold', value: '5°',        meaning: 'If two adjacent meridians differ by more than this, an intermediate meridian is added.' },
  { param: 'Outlier factor',     value: '0.40',      meaning: 'A point deviating ≥40% from its neighbors\u2019 average is automatically retested.' },
]

const RING_ROWS: Row[] = [
  { param: 'Expansion step',  value: '0.5°',          meaning: 'Eccentricity increment per scroll tick or arrow press.' },
  { param: 'Sector gap',      value: '4°',            meaning: 'Angular gap between adjacent sectors so each is independently mapped.' },
  { param: 'Default sectors', value: '8',             meaning: 'Default 45°-wide pie sectors. Presets: 4 / 8 / 12 / 24.' },
  { param: 'V4e thickness',   value: '1.5°',          meaning: 'Arc band width — wider for larger Goldmann V stimulus.' },
  { param: 'III4e thickness', value: '0.7°',          meaning: 'Arc band width for bright medium stimulus.' },
  { param: 'III2e thickness', value: '0.5°',          meaning: 'Arc band width for dim medium stimulus.' },
  { param: 'I4e thickness',   value: '0.35°',         meaning: 'Arc band width for bright small stimulus.' },
  { param: 'I2e thickness',   value: '0.25°',         meaning: 'Arc band width for dim small stimulus.' },
]

const STATIC_ROWS: Row[] = [
  { param: 'Default points per level', value: '100',       meaning: 'Target hexagonal grid density per isopter level.' },
  { param: 'Min eccentricity',         value: '1.5°',      meaning: 'Skip the central fixation area (keeps the dot from being mistaken for a stimulus).' },
  { param: 'Density exponent',         value: '1.5',       meaning: '>1 packs more points centrally — compensates the Goldmann-bowl-to-flat-screen projection.' },
  { param: 'Max testable field',       value: '80°',       meaning: 'Hard ceiling on angular extent (beyond is brow/nose territory).' },
  { param: 'V4e / III4e field',        value: '100%',      meaning: 'Bright stimuli use the full available field.' },
  { param: 'III2e field',              value: '85%',       meaning: 'Slightly reduced peripheral coverage for dim medium.' },
  { param: 'I4e field',                value: '75%',       meaning: 'Small bright stays away from the dead far periphery.' },
  { param: 'I2e field',                value: '65%',       meaning: 'Smallest dim restricted to where it has any chance of being seen.' },
  ...buildSpeedPresetRows(),
  { param: 'Burst stagger',            value: '150 ms',    meaning: 'Spacing between dots in a multi-dot burst.' },
  { param: 'Min response time',        value: '150 ms',    meaning: 'False-start threshold.' },
]

const CALIB_ROWS: Row[] = [
  { param: 'Reference object',     value: '85.6 × 54 mm', meaning: 'ISO/IEC 7810 ID-1 (credit card). User aligns it on screen to compute pixels-per-mm.' },
  { param: 'Pixels per degree',    value: 'derived',      meaning: 'pxPerMm × mm-per-degree at the user-entered viewing distance.' },
  { param: 'Reaction-time trials', value: '5',            meaning: 'Number of go/no-go trials. Median is used; default 250 ms if skipped.' },
  { param: 'RT delay window',      value: '1500–3500 ms', meaning: 'Random delay before the dot appears in each RT trial.' },
  { param: 'RT compensation',      value: '3 × medianRT', meaning: 'At 3°/s, every recorded eccentricity is shifted outward by the distance the stimulus moved during the user\u2019s reaction time.' },
  { param: 'Brightness floor',     value: '~0.04 default', meaning: 'Minimum visible opacity, calibrated per device. Effective minimum is floor × 1.5.' },
  { param: 'Fixation offset',      value: '20% (10% mobile)', meaning: 'Fixation dot is shifted toward the nasal side so the temporal field gets maximum screen coverage.' },
]

const MAPPING_ROWS: Row[] = [
  { param: 'Pixels per mm',    value: 'cardPx ÷ 85.6 mm', meaning: 'Derived from the on-screen credit-card alignment. Mobile mode replaces this with a 10 mm calibration bar.' },
  { param: 'Pixels per degree', value: 'pxPerMm × distanceCm × 10 × tan(1°)', meaning: 'Small-angle conversion. At a 50 cm viewing distance, 1° of visual angle ≈ 8.7 mm on the screen.' },
  { param: 'Fixation X (right eye)', value: 'screenW / 2 − offset', meaning: 'Fixation dot is shifted toward the nasal side so the temporal field gets the most screen room.' },
  { param: 'Fixation X (left eye)',  value: 'screenW / 2 + offset', meaning: 'Mirrored offset for the left eye.' },
  { param: 'Fixation Y',       value: 'screenH / 2',  meaning: 'Vertically centred — superior and inferior fields share the screen evenly.' },
  { param: 'Offset magnitude (desktop)', value: '20% of screenW', meaning: 'Default nasal shift on a normal screen.' },
  { param: 'Offset magnitude (mobile)',  value: '10% of screenW', meaning: 'Smaller shift on phones; the screen is too narrow to spend more on offset.' },
  { param: 'Max eccentricity',  value: 'max(left, right, top, bottom) / pxPerDeg', meaning: 'Largest angular distance from fixation to any screen edge. This is the radius the perimetry chart uses.' },
  { param: 'Per-meridian limit', value: 'edgeDistance(angle) / pxPerDeg', meaning: 'Each meridian gets its own ceiling — a stimulus on the temporal axis can travel further than one on the vertical axis.' },
  { param: 'Stimulus position', value: 'fixation + ecc × pxPerDeg × (cos θ, −sin θ)', meaning: 'Polar-to-Cartesian, with screen-Y inverted because the SVG/DOM Y axis grows downward.' },
  { param: 'Stimulus size (px)', value: 'sizeDeg × pxPerDeg', meaning: 'Goldmann stimulus diameter is converted to pixels using the same px-per-degree scale.' },
  { param: 'Stimulus brightness', value: 'opacity = max(brightnessFloor × 1.5, intensityFrac)', meaning: 'Dim stimuli (intensityFrac 0.10) are clamped above the per-device brightness floor so they remain visible.' },
]

const SEVERITY_ROWS: Row[] = [
  { param: 'Within normal range',         value: '> 85%',  meaning: 'III4e isopter covers >85% of the testable disk (π × maxEcc²). At-home tests cannot replicate the full clinical 90° field.' },
  { param: 'Borderline / Early changes',  value: '70–85%', meaning: 'Near-normal field with possible early constriction; can also reflect normal variation or test conditions.' },
  { param: 'Mild constriction',           value: '45–70%', meaning: 'Some peripheral loss; central vision well preserved; possible difficulty in dim lighting.' },
  { param: 'Moderate constriction',       value: '20–45%', meaning: 'Reduced peripheral awareness. Night vision and unfamiliar environments often affected.' },
  { param: 'Severe constriction',         value: '5–20%',  meaning: 'Often meets legal-blindness criteria when the central field is ≤20° diameter.' },
  { param: 'Very severe constriction',    value: '< 5%',   meaning: 'Tiny remaining central island. Daily activities and mobility severely affected.' },
]

const RING_SCOTOMA_ROWS: Row[] = [
  { param: 'Drop ratio',          value: '> 60%',          meaning: 'Trigger condition — area drop between consecutive isopters exceeds 60% of the outer isopter.' },
  { param: 'Min outer area',      value: '> 1500 deg²',    meaning: 'Only flagged when the outer isopter is substantial enough to make the drop meaningful.' },
  { param: 'Severe (inner area)', value: '≤ 100 deg²',     meaning: 'The remaining central island is very small — central vision restricted.' },
  { param: 'Moderate',            value: '100–800 deg²',   meaning: 'Classic mid-stage RP ring-scotoma pattern.' },
  { param: 'Mild',                value: '> 800 deg²',     meaning: 'Localized mid-peripheral band with central vision largely preserved.' },
]

const SENSITIVITY_GRADIENT_ROWS: Row[] = [
  { param: 'Skip threshold',      value: 'III4e < 500 deg²', meaning: 'Field too small to compare bright vs dim meaningfully.' },
  { param: 'Steep drop-off',      value: '< 5%',             meaning: 'III2e ≪ III4e — sharp scotoma boundary, typical of RP.' },
  { param: 'Significant gradient', value: '5–20%',           meaning: 'Large dim-stimulus loss in the mid-periphery.' },
  { param: 'Moderate gradient',   value: '20–50%',           meaning: 'Reduced retinal sensitivity but not yet severe.' },
  { param: 'Preserved sensitivity', value: '> 50%',          meaning: 'Dim stimulus still sees most of the bright-stimulus area.' },
]

const RELIABILITY_ROWS: Row[] = [
  { param: 'Major isopter reversal',  value: '−12 / pair',  meaning: 'Inner isopter > 3× outer isopter. Strong indicator of fixation loss or guessing.' },
  { param: 'Mild isopter overlap',    value: '−3 / pair',   meaning: 'Inner > outer by 1.5–3×. Often consistent with an irregular boundary.' },
  { param: 'Irregular shape',         value: 'up to −25',   meaning: 'Coefficient of variation across meridians >30%. Penalty scales linearly above the threshold.' },
  { param: 'Sparse data',             value: 'up to −20',   meaning: 'Fewer than 30 detected points overall.' },
  { param: 'Sparse meridians',        value: 'up to −15',   meaning: 'Fewer than 8 distinct meridians produced data.' },
  { param: 'Low detection rate',      value: 'up to −15',   meaning: 'Overall hit rate <40%. Suggests attention/fixation issues.' },
  { param: 'High retest ratio',       value: 'up to −10',   meaning: '>30% of points required automatic retesting (noisy responses).' },
]

const RELIABILITY_BAND_ROWS: Row[] = [
  { param: 'High reliability',     value: '≥ 85', meaning: 'High confidence in the result.' },
  { param: 'Moderate reliability', value: '65–84', meaning: 'Acceptable, with minor concerns flagged.' },
  { param: 'Low reliability',      value: '40–64', meaning: 'Notable issues; consider repeating in a calmer setting.' },
  { param: 'Very low reliability', value: '< 40',  meaning: 'Significant concerns — interpret with caution.' },
]

const RP_FINDING_ROWS: Row[] = [
  { param: 'Concentric constriction', value: 'III4e fraction < 65%', meaning: 'Hallmark RP pattern: tunnel-like overall reduction.' },
  { param: 'Ring scotoma',            value: 'inner:outer < 30%',     meaning: 'Disproportionate mid-peripheral drop while central + far periphery survive.' },
  { param: 'Scotopic loss',           value: 'III2e:III4e < 30%',     meaning: 'Dim stimulus barely perceived — rod-mediated sensitivity loss.' },
  { param: 'Central preservation',    value: 'I2e > 20 deg² and III4e < 2000 deg²', meaning: 'Tunnel pattern: small intact central island within a heavily constricted outer field.' },
  { param: 'Vertical asymmetry',      value: 'sup:inf ratio < 0.65',  meaning: '>35% imbalance between upper and lower hemifields.' },
]

export function MethodsPage({ onBack }: Props) {
  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <div className="max-w-3xl mx-auto space-y-10 pb-12">
        <div className="flex items-center justify-between pb-5 border-b border-white/[0.06]">
          <h1 className="text-3xl font-heading font-bold">Methods &amp; parameters</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        <p className="text-zinc-300 leading-relaxed">
          A complete reference of every threshold and constant used by {APP_NAME} —
          from stimulus definitions, through the test loops, to the algorithms that turn
          your responses into a severity classification. If you want to inspect, replicate, or
          critique the method, this is the starting point.
        </p>

        <Section
          title="Stimulus definitions"
          intro="Modeled on classical Goldmann notation. Size is angular diameter at the user's calibrated viewing distance; intensity is rendered as opacity relative to the per-device brightness floor. The same five stimuli are reused across all three test types."
        >
          <ParamTable rows={STIMULI_ROWS} />
        </Section>

        <Section
          title="Goldmann test (kinetic)"
          intro="Classic kinetic perimetry: a stimulus moves slowly inward along each meridian; you press a key the moment you see it. Each detected position becomes one node on an isopter. The test runs five stimulus levels in sequence, with adaptive refinement for noisy areas."
        >
          <h3 className="text-sm font-medium text-zinc-300">Speeds and timing</h3>
          <ParamTable rows={GOLDMANN_SPEED_ROWS} />
          <h3 className="text-sm font-medium text-zinc-300 pt-2">Sampling and adaptive logic</h3>
          <ParamTable rows={GOLDMANN_LOGIC_ROWS} />
        </Section>

        <Section
          title="Ring test"
          intro="A user-controlled variant: you expand a thin ring outward yourself (scroll, drag, or arrow keys) while fixating, and tap the moment it disappears or reappears. The field is divided into pie sectors so each is mapped independently — useful for irregular scotomas. There is no reaction-time component."
        >
          <ParamTable rows={RING_ROWS} />
        </Section>

        <Section
          title="Static test"
          intro="Adaptive static perimetry over a hexagonal grid that gets denser toward fixation. Dots flash at random positions for a fixed window; you press as soon as you see one. Each level reuses the unseen-zone map from the previous level so dim stimuli aren't wasted on already-dead retina."
        >
          <ParamTable rows={STATIC_ROWS} />
        </Section>

        <Section
          title="Calibration"
          intro="A short setup phase before every test. Pixel-to-degree scaling and reaction-time compensation both depend on values measured here, so the rest of the test only makes sense in the context of these constants."
        >
          <ParamTable rows={CALIB_ROWS} />
        </Section>

        <Section
          title="Mapping the visual field to the screen"
          intro="Once the calibration values are in hand, every visual-field coordinate becomes a pixel on your screen. The conversion is small-angle trigonometry: at a known viewing distance, one degree of visual angle subtends a fixed number of millimetres, which the calibrated pixel-per-mm scale turns into pixels. The fixation point is shifted toward the nose so the temporal field — usually the more interesting half in RP — gets the most screen real estate. Because the screen is rectangular, the maximum testable eccentricity is direction-dependent: a stimulus on the horizontal axis can travel further than one on the vertical axis, and per-meridian ceilings are computed individually."
        >
          <ParamTable rows={MAPPING_ROWS} />
        </Section>

        <Section
          title="Severity classification"
          intro="The headline severity label is computed from the III4e isopter area as a fraction of the testable disk (π × maxEccentricity²). Ring scotomas are detected first and override the simple area band, because a ring scotoma can leave the III4e isopter looking deceptively normal."
        >
          <ParamTable rows={SEVERITY_ROWS} />
        </Section>

        <Section
          title="Ring-scotoma detection"
          intro="A ring scotoma shows up as a steep area drop between consecutive isopters in a field that is otherwise sizeable. The inner-isopter area determines how severe the resulting tunnel is."
        >
          <ParamTable rows={RING_SCOTOMA_ROWS} />
        </Section>

        <Section
          title="Sensitivity gradient (III2e ÷ III4e)"
          intro="Comparing the dim and bright versions of the same stimulus size estimates how steep the sensitivity drop-off is. RP patients typically have a sharp boundary, where the dim stimulus is barely seen even though the bright one is."
        >
          <ParamTable rows={SENSITIVITY_GRADIENT_ROWS} />
        </Section>

        <Section
          title="RP-specific findings"
          intro="Pattern detectors that look for hallmark RP signatures in the isopter geometry. Each is reported separately in the result interpretation."
        >
          <ParamTable rows={RP_FINDING_ROWS} />
        </Section>

        <Section
          title="Reliability score (isopter-based)"
          intro="Every kinetic result carries a 0–100 reliability score. It starts at 100 and accumulates penalties from the checks below. The score band controls the colour shown next to your result. This is separate from Fixation Accuracy and False-Positive Response Rate below — those are per-trial fixation metrics adopted from Specvis."
        >
          <h3 className="text-sm font-medium text-zinc-300">Penalty components</h3>
          <ParamTable rows={RELIABILITY_ROWS} />
          <h3 className="text-sm font-medium text-zinc-300 pt-2">Score bands</h3>
          <ParamTable rows={RELIABILITY_BAND_ROWS} />
        </Section>

        <Section
          title="Fixation monitoring (catch trials)"
          intro="During the static test, a blindspot catch trial is injected periodically. A bright V4e stimulus is flashed at the anatomical blindspot; a patient fixating correctly will NOT see it. Any 'seen' response is a fixation-loss signal. The values below are dynamically imported from the application source — they cannot drift from the code."
        >
          <ParamTable
            rows={(() => {
              const bs = blindspotLocation('right')
              return [
                {
                  param: 'Catch-trial cadence',
                  value: `every ${CATCH_TRIAL_EVERY_N} presentations`,
                  meaning: `Default per Dzwiniel et al. 2017 (Specvis's monitorFixationEveryXStimuli).`,
                },
                {
                  param: 'Blindspot location (right eye)',
                  value: `${bs.eccentricityDeg.toFixed(1)}° at meridian ${bs.meridianDeg.toFixed(1)}°`,
                  meaning: `Temporal side, ~1.5° below horizontal. Left eye is mirrored.`,
                },
                {
                  param: 'Catch-trial stimulus',
                  value: `V4e (${STIMULI['V4e'].sizeDeg}° · full intensity)`,
                  meaning: `Brightest available — any reported detection is an unambiguous fixation-loss signal, not a sensitivity-edge artifact.`,
                },
                {
                  param: 'Fixation-loss alert',
                  value: FIXATION_LOSS_ALERT_MS === 0
                    ? 'disabled'
                    : `"${FIXATION_LOSS_ALERT_MESSAGE}" shown for ${FIXATION_LOSS_ALERT_MS} ms`,
                  meaning: 'Immediate on-screen feedback when a catch trial is incorrectly detected. Does not pause the test.',
                },
              ]
            })()}
          />
          <p className="text-xs text-zinc-500 italic pt-1">
            These values are tuneable in an upcoming Advanced Settings release.
          </p>
        </Section>

        <Section
          title="Reliability indices (FA and FPRR)"
          intro="Two per-trial reliability metrics adopted from Dzwiniel et al., PLoS ONE 2017 (Specvis-Desktop). Both are computed at display time from the stored raw counts on each TestResult. Reference ranges are from the paper's healthy control cohort (n=21, aged 22–28)."
        >
          <ParamTable
            rows={[
              {
                param: 'Fixation Accuracy (FA)',
                value: `${RELIABILITY_REFERENCE_RANGES.faPercent.min}–${RELIABILITY_REFERENCE_RANGES.faPercent.max}% normal`,
                meaning: `(catchTrialsPresented − catchTrialsFalsePositive) / catchTrialsPresented × 100. Percentage of blindspot catch trials correctly ignored.`,
              },
              {
                param: 'False-Positive Response Rate (FPRR)',
                value: `${RELIABILITY_REFERENCE_RANGES.fprrPercent.min}–${RELIABILITY_REFERENCE_RANGES.fprrPercent.max}% normal`,
                meaning: `(catchFP + isiFP) / (catchFP + isiFP + truePositives) × 100. Percentage of key presses when no stimulus was shown (catch-trial + gap-window presses combined).`,
              },
            ]}
          />
          <p className="text-xs text-zinc-500 pt-1">Reference: {RELIABILITY_REFERENCE_RANGES.citation}.</p>
        </Section>

        <Section
          title="Sphericity correction"
          intro="Optional per-calibration. When enabled, degrees-to-pixels conversion uses d = D·tan(θ) instead of the small-angle linear approximation θ·ppd. The two models agree to within 1% inside 5° of fixation but diverge substantially at the edge of the extended (~80°) field. Default is off so results recorded before April 2026 remain bitwise reproducible."
        >
          <ParamTable
            rows={[
              { param: 'Formula (off, default)', value: 'd_px = θ · pixelsPerDegree',            meaning: 'Linear small-angle approximation. Good within ~20° of fixation.' },
              { param: 'Formula (on)',           value: 'd_px = D · tan(θ) · pixelsPerCm',       meaning: 'True flat-screen projection. Recommended when extended field is enabled.' },
              { param: 'Magnitude of correction at 30°', value: '~10% larger than linear',       meaning: 'Peripheral stimuli appear further from fixation on screen than the linear model predicts.' },
              { param: 'Magnitude of correction at 60°', value: '~65% larger than linear',       meaning: 'Large — linear model systematically under-projects the far periphery.' },
            ]}
          />
        </Section>

        <Section
          title="Related tools and where this project stands"
          intro="Browser-based and consumer visual-field self-tests are a small but growing space. The table below positions this project honestly against the tools most often cited alongside it."
        >
          <div className="overflow-x-auto rounded-xl border border-white/[0.06]">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.03] text-zinc-400 text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Tool</th>
                  <th className="text-left font-medium px-4 py-2">Platform</th>
                  <th className="text-left font-medium px-4 py-2">Test type</th>
                  <th className="text-left font-medium px-4 py-2">Validation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.05]">
                <tr className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-zinc-200 font-medium">HFA (Humphrey)</td>
                  <td className="px-4 py-2 text-zinc-400">Clinical perimeter</td>
                  <td className="px-4 py-2 text-zinc-400">SITA 24-2 / 30-2 / 10-2</td>
                  <td className="px-4 py-2 text-zinc-400">Clinical gold standard</td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-zinc-200 font-medium">Specvis Desktop</td>
                  <td className="px-4 py-2 text-zinc-400">Windows / macOS / Linux</td>
                  <td className="px-4 py-2 text-zinc-400">Static staircase, 48/96 pts</td>
                  <td className="px-4 py-2 text-zinc-400">vs Medmont M700 (Dzwiniel 2017)</td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-zinc-200 font-medium">Peristat Online</td>
                  <td className="px-4 py-2 text-zinc-400">Web — any monitor</td>
                  <td className="px-4 py-2 text-zinc-400">Suprathreshold (4 levels)</td>
                  <td className="px-4 py-2 text-zinc-400">80–86% sens, 94–97% spec vs HFA</td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="px-4 py-2 text-zinc-200 font-medium">Visual Fields Easy</td>
                  <td className="px-4 py-2 text-zinc-400">iPad</td>
                  <td className="px-4 py-2 text-zinc-400">Suprathreshold, 96 pts</td>
                  <td className="px-4 py-2 text-zinc-400">Inadequate for one-time home screen</td>
                </tr>
                <tr className="bg-white/[0.04] font-semibold">
                  <td className="px-4 py-2 text-accent">{APP_NAME}</td>
                  <td className="px-4 py-2 text-zinc-300">Web — any browser</td>
                  <td className="px-4 py-2 text-zinc-300">Kinetic + static + ring</td>
                  <td className="px-4 py-2 text-zinc-300">Not yet validated against a clinical perimeter</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-zinc-400">
            If a defect appears in your results, follow up with an ophthalmologist for a
            test on a calibrated clinical perimeter. This tool is not a diagnostic device.
          </p>
        </Section>

        <div className="bg-surface rounded-2xl p-6 space-y-2 border border-white/[0.06]">
          <p className="text-sm text-zinc-300">
            All thresholds above are the defaults the app ships with. They are tuned for
            self-screening on standard desktop screens, not clinical diagnosis. If you spot a
            value you think should be different — or want to argue for a different methodology —
            get in touch via the contact page.
          </p>
        </div>
      </div>
    </main>
  )
}
