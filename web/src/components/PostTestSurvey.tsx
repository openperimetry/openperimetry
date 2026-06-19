import { useState } from 'react'
import { trackEvent } from '../api'
import { getDeviceId } from '../storage'

export interface SurveyResponse {
  perceivedAccuracy: number | null     // 1-5 scale, null = unanswered
  easeOfUse: number | null             // 1-5 scale, null = unanswered
  instructionsClarity: number | null   // 1-5 scale, null = unanswered
  freeformFeedback: string
}

interface Props {
  onSubmit: (response: SurveyResponse) => void
  onSkip: () => void
}

const ACCURACY_LABELS = ['Very inaccurate', 'Somewhat inaccurate', 'Neutral', 'Somewhat accurate', 'Very accurate']
const EASE_LABELS = ['Very difficult', 'Difficult', 'Neutral', 'Easy', 'Very easy']
const CLARITY_LABELS = ['Very unclear', 'Unclear', 'Neutral', 'Clear', 'Very clear']

function ScaleInput({
  value, onChange, labels, groupLabel,
}: { value: number | null; onChange: (v: number) => void; labels: string[]; groupLabel: string }) {
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
                : 'bg-surface border-line text-muted hover:border-line'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted px-1">
        <span>{labels[0]}</span>
        <span>{labels[4]}</span>
      </div>
    </div>
  )
}

export function PostTestSurvey({ onSubmit, onSkip }: Props) {
  const [perceivedAccuracy, setPerceivedAccuracy] = useState<number | null>(null)
  const [easeOfUse, setEaseOfUse] = useState<number | null>(null)
  const [instructionsClarity, setInstructionsClarity] = useState<number | null>(null)
  const [freeformFeedback, setFreeformFeedback] = useState('')

  const hasInput =
    perceivedAccuracy !== null ||
    easeOfUse !== null ||
    instructionsClarity !== null ||
    freeformFeedback.trim() !== ''

  const handleSubmit = () => {
    const response: SurveyResponse = {
      perceivedAccuracy,
      easeOfUse,
      instructionsClarity,
      freeformFeedback,
    }
    trackEvent('survey_submitted', getDeviceId()).catch(() => {})
    onSubmit(response)
  }

  return (
    <div className="bg-surface rounded-2xl p-5 space-y-5 border border-line">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-ink">Quick feedback (optional)</h3>
          <p className="text-xs text-muted">Your answers help us improve the test.</p>
        </div>
        <button onClick={onSkip} className="text-xs text-muted hover:text-body transition-colors min-h-[44px] px-2 shrink-0">
          Skip
        </button>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted" id="accuracy-label">How accurate do the results feel?</p>
        <ScaleInput value={perceivedAccuracy} onChange={setPerceivedAccuracy} labels={ACCURACY_LABELS} groupLabel="Perceived accuracy" />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted" id="ease-label">How easy was the test to complete?</p>
        <ScaleInput value={easeOfUse} onChange={setEaseOfUse} labels={EASE_LABELS} groupLabel="Ease of use" />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted" id="clarity-label">How clear were the instructions?</p>
        <ScaleInput value={instructionsClarity} onChange={setInstructionsClarity} labels={CLARITY_LABELS} groupLabel="Instructions clarity" />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="survey-feedback" className="text-xs text-muted">Any other feedback?</label>
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
        disabled={!hasInput}
        className="w-full py-2.5 btn-primary rounded-xl text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Submit feedback
      </button>
    </div>
  )
}
