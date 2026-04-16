import { useState } from 'react'
import { trackEvent } from '../api'
import { getDeviceId } from '../storage'

export interface SurveyResponse {
  perceivedAccuracy: number // 1-5 scale
  easeOfUse: number // 1-5 scale
  comparedToClinical?: 'more_sensitive' | 'similar' | 'less_sensitive' | 'never_had_clinical'
  freeformFeedback: string
}

interface Props {
  onSubmit: (response: SurveyResponse) => void
  onSkip: () => void
}

const ACCURACY_LABELS = ['Very inaccurate', 'Somewhat inaccurate', 'Neutral', 'Somewhat accurate', 'Very accurate']
const EASE_LABELS = ['Very difficult', 'Difficult', 'Neutral', 'Easy', 'Very easy']

function ScaleInput({
  value, onChange, labels, groupLabel,
}: { value: number; onChange: (v: number) => void; labels: string[]; groupLabel: string }) {
  return (
    <div className="space-y-2" role="radiogroup" aria-label={groupLabel}>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map(v => (
          <button
            key={v}
            onClick={() => onChange(v)}
            role="radio"
            aria-checked={value === v}
            aria-label={`${v} — ${labels[v - 1]}`}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors border ${
              value === v
                ? 'bg-accent border-accent text-white'
                : 'bg-surface border-white/[0.06] text-zinc-400 hover:border-white/[0.12]'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-xs text-zinc-500 px-1">
        <span>{labels[0]}</span>
        <span>{labels[4]}</span>
      </div>
    </div>
  )
}

export function PostTestSurvey({ onSubmit, onSkip }: Props) {
  const [perceivedAccuracy, setPerceivedAccuracy] = useState(3)
  const [easeOfUse, setEaseOfUse] = useState(3)
  const [comparedToClinical, setComparedToClinical] = useState<SurveyResponse['comparedToClinical']>()
  const [freeformFeedback, setFreeformFeedback] = useState('')

  const handleSubmit = () => {
    const response: SurveyResponse = {
      perceivedAccuracy,
      easeOfUse,
      comparedToClinical,
      freeformFeedback,
    }
    trackEvent('survey_submitted', getDeviceId()).catch(() => {})
    onSubmit(response)
  }

  return (
    <div className="bg-surface rounded-2xl p-5 space-y-5 border border-white/[0.06]">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-white">Quick feedback (optional)</h3>
          <p className="text-xs text-zinc-500">Your answers help us improve the test.</p>
        </div>
        <button onClick={onSkip} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] px-2 shrink-0">
          Skip
        </button>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-zinc-400" id="accuracy-label">How accurate does this result feel compared to your actual vision?</p>
        <ScaleInput value={perceivedAccuracy} onChange={setPerceivedAccuracy} labels={ACCURACY_LABELS} groupLabel="Perceived accuracy" />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-zinc-400" id="ease-label">How easy was the test to complete?</p>
        <ScaleInput value={easeOfUse} onChange={setEaseOfUse} labels={EASE_LABELS} groupLabel="Ease of use" />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-zinc-400" id="compare-label">How does this compare to clinical perimetry?</p>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby="compare-label">
          {([
            ['never_had_clinical', 'Never had clinical test'],
            ['more_sensitive', 'This detects more'],
            ['similar', 'Similar results'],
            ['less_sensitive', 'Clinical detects more'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setComparedToClinical(val)}
              role="radio"
              aria-checked={comparedToClinical === val}
              className={`py-2 px-2 rounded-lg text-xs font-medium transition-colors border ${
                comparedToClinical === val
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface border-white/[0.06] text-zinc-400 hover:border-white/[0.12]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="survey-feedback" className="text-xs text-zinc-400">Any other feedback?</label>
        <textarea
          id="survey-feedback"
          value={freeformFeedback}
          onChange={e => setFreeformFeedback(e.target.value)}
          placeholder="Suggestions, issues, what worked well..."
          rows={3}
          className="input-field resize-none"
        />
      </div>

      <button
        onClick={handleSubmit}
        className="w-full py-2.5 btn-primary rounded-xl text-sm font-medium text-white"
      >
        Submit feedback
      </button>
    </div>
  )
}
