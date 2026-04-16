import { useState } from 'react'

export interface SurveyResponse {
  // Test feedback
  perceivedAccuracy: number // 1-5 scale
  easeOfUse: number // 1-5 scale
  comparedToClinical?: 'more_sensitive' | 'similar' | 'less_sensitive' | 'never_had_clinical'
  freeformFeedback: string

  // Disease info
  age?: number
  yearsDiagnosed?: number
  rpType?: 'autosomal_dominant' | 'autosomal_recessive' | 'x_linked' | 'usher' | 'unknown' | 'other'
  currentAid?: 'none' | 'glasses' | 'cane' | 'guide_dog' | 'multiple'
  clinicalFieldTest?: 'never' | 'within_year' | '1_3_years' | 'over_3_years'
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
  const [step, setStep] = useState<'feedback' | 'disease'>('feedback')

  const [perceivedAccuracy, setPerceivedAccuracy] = useState(3)
  const [easeOfUse, setEaseOfUse] = useState(3)
  const [comparedToClinical, setComparedToClinical] = useState<SurveyResponse['comparedToClinical']>()
  const [freeformFeedback, setFreeformFeedback] = useState('')

  const [age, setAge] = useState<string>('')
  const [yearsDiagnosed, setYearsDiagnosed] = useState<string>('')
  const [rpType, setRpType] = useState<SurveyResponse['rpType']>()
  const [currentAid, setCurrentAid] = useState<SurveyResponse['currentAid']>()
  const [clinicalFieldTest, setClinicalFieldTest] = useState<SurveyResponse['clinicalFieldTest']>()

  const handleSubmit = () => {
    onSubmit({
      perceivedAccuracy,
      easeOfUse,
      comparedToClinical,
      freeformFeedback,
      age: age ? Number(age) : undefined,
      yearsDiagnosed: yearsDiagnosed ? Number(yearsDiagnosed) : undefined,
      rpType,
      currentAid,
      clinicalFieldTest,
    })
  }

  if (step === 'feedback') {
    return (
      <div className="bg-surface rounded-2xl p-5 space-y-5 border border-white/[0.06]">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-white">Quick feedback (optional)</h3>
          <button onClick={onSkip} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] px-2">
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

        <div className="flex gap-3">
          <button
            onClick={() => setStep('disease')}
            className="flex-1 py-2.5 btn-primary rounded-xl text-sm font-medium text-white"
          >
            Continue
          </button>
          <button
            onClick={handleSubmit}
            className="py-2.5 px-4 bg-elevated hover:bg-overlay rounded-xl text-sm font-medium transition-colors text-zinc-300"
          >
            Submit now
          </button>
        </div>
      </div>
    )
  }

  // Disease info step
  return (
    <div className="bg-surface rounded-2xl p-5 space-y-5 border border-white/[0.06]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white">About your condition (optional)</h3>
        <button onClick={handleSubmit} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors min-h-[44px] px-2">
          Skip &amp; submit
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        This helps us understand our users better and improve the test. All fields are optional.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="survey-age" className="text-xs text-zinc-400">Age</label>
          <input
            id="survey-age"
            type="number"
            value={age}
            onChange={e => setAge(e.target.value)}
            placeholder="e.g. 42"
            min={1}
            max={120}
            className="input-field"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="survey-years" className="text-xs text-zinc-400">Years since <abbr title="Retinitis Pigmentosa">RP</abbr> diagnosis</label>
          <input
            id="survey-years"
            type="number"
            value={yearsDiagnosed}
            onChange={e => setYearsDiagnosed(e.target.value)}
            placeholder="e.g. 8"
            min={0}
            max={80}
            className="input-field"
          />
        </div>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-xs text-zinc-400"><abbr title="Retinitis Pigmentosa">RP</abbr> type (if known)</legend>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {([
            ['autosomal_dominant', 'Autosomal dominant'],
            ['autosomal_recessive', 'Autosomal recessive'],
            ['x_linked', 'X-linked'],
            ['usher', 'Usher syndrome'],
            ['unknown', 'Unknown / unsure'],
            ['other', 'Other'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setRpType(val)}
              role="radio"
              aria-checked={rpType === val}
              className={`py-2 px-1 rounded-lg text-xs font-medium transition-colors border ${
                rpType === val
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface border-white/[0.06] text-zinc-400 hover:border-white/[0.12]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-xs text-zinc-400">Visual aids used</legend>
        <div className="grid grid-cols-3 gap-2" role="radiogroup">
          {([
            ['none', 'None'],
            ['glasses', 'Glasses/contacts'],
            ['cane', 'White cane'],
            ['guide_dog', 'Guide dog'],
            ['multiple', 'Multiple aids'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setCurrentAid(val)}
              role="radio"
              aria-checked={currentAid === val}
              className={`py-2 px-1 rounded-lg text-xs font-medium transition-colors border ${
                currentAid === val
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface border-white/[0.06] text-zinc-400 hover:border-white/[0.12]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-xs text-zinc-400">Last clinical visual field test</legend>
        <div className="grid grid-cols-2 gap-2" role="radiogroup">
          {([
            ['never', 'Never'],
            ['within_year', 'Within last year'],
            ['1_3_years', '1–3 years ago'],
            ['over_3_years', 'Over 3 years ago'],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              onClick={() => setClinicalFieldTest(val)}
              role="radio"
              aria-checked={clinicalFieldTest === val}
              className={`py-2 px-2 rounded-lg text-xs font-medium transition-colors border ${
                clinicalFieldTest === val
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface border-white/[0.06] text-zinc-400 hover:border-white/[0.12]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <button
        onClick={handleSubmit}
        className="w-full py-2.5 btn-primary rounded-xl text-sm font-medium text-white"
      >
        Submit feedback
      </button>
    </div>
  )
}
