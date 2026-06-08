import { BackButton } from './AccessibleNav'

interface Props {
  onBack: () => void
  onContact: () => void
}

const PORTAL_FEATURES = [
  {
    title: 'Study profiles',
    body: 'Create locked protocols with test type, pacing, grid, calibration, and advanced settings so every participant run follows the same configuration.',
  },
  {
    title: 'Participant sessions',
    body: 'Run tests from a clinician-scoped workflow that tags results with study, participant, visit, session, and operator metadata.',
  },
  {
    title: 'Workstation screens',
    body: 'Save calibrated display setups for clinic devices so repeated tests do not depend on ad-hoc screen measurements.',
  },
  {
    title: 'Result review and export',
    body: 'Review study-tagged results, filter by study or participant, export OVFX bundles, and generate PDF reports for discussion.',
  },
]

const VALIDATION_HELP = [
  'Compare home-run or clinic-run results against standard clinical perimetry such as Humphrey, Octopus, Medmont, or Goldmann.',
  'Help define practical protocols for RP monitoring, low-vision follow-up, and longitudinal self-monitoring.',
  'Identify where the tool is clinically useful, where it is misleading, and what reliability signals clinicians need before trusting a report.',
]

const CLINICIAN_REASONS = [
  {
    title: 'Shape a tool patients may already try',
    body: 'Patients increasingly arrive with app-based measurements and screenshots. Clinician input can make this tool safer, clearer, and less likely to overstate what a home screen can measure.',
  },
  {
    title: 'Improve longitudinal monitoring between visits',
    body: 'If validated, repeatable at-home or clinic-adjacent testing could help surface meaningful change between formal perimetry appointments, especially for slowly progressive retinal disease.',
  },
  {
    title: 'Generate practical validation data',
    body: 'Side-by-side comparisons against clinical perimeters can answer concrete questions about agreement, test-retest variability, usable endpoints, and which patient groups benefit most.',
  },
  {
    title: 'Influence open research infrastructure',
    body: 'OpenPerimetry exports interoperable data and is designed around transparent methods. Clinician collaborators can help set the standards before habits and report formats harden.',
  },
  {
    title: 'Directly shape the product',
    body: 'I am happy to cooperate on adjusting the app around clinician needs, including study workflows, report wording, protocol controls, exports, and portal features that would make validation or supervised use easier.',
  },
  {
    title: 'Run your own instance',
    body: 'I can also help clinics or research groups host their own version of OpenPerimetry, so validation studies can run on infrastructure, branding, data-handling, and governance arrangements that fit the local project.',
  },
]

export function CliniciansPage({ onBack, onContact }: Props) {
  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <div className="mx-auto max-w-3xl space-y-10 pb-12">
        <div className="flex items-center justify-between gap-4 border-b border-white/[0.06] pb-5">
          <h1 className="text-3xl font-heading font-bold">For clinicians</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        <section className="space-y-4">
          <p className="text-lg leading-relaxed text-zinc-200">
            OpenPerimetry is looking for clinicians and vision researchers who can help validate this tool against clinical perimetry.
          </p>
          <p className="text-sm leading-relaxed text-zinc-400">
            The app is still a screen-based self-check, not a diagnostic device. Clinician collaboration is needed to measure agreement, repeatability, failure modes, and what kinds of reports are actually useful in practice.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              onClick={onContact}
              className="rounded-xl btn-primary px-4 py-3 text-sm font-semibold text-white"
            >
              Request a clinician account
            </button>
            <button
              onClick={onBack}
              className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm font-medium text-zinc-200 hover:bg-white/[0.06] hover:text-white"
            >
              Back to test
            </button>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-heading font-bold">How to request access</h2>
          <div className="rounded-2xl border border-white/[0.06] bg-surface/60 p-5 text-sm leading-relaxed text-zinc-300">
            <p>
              Use the contact form and mention that you are requesting a clinician account. Include your name, institution or clinic, role, and a short note about how you would like to evaluate or use the tool.
            </p>
            <p className="mt-3 text-zinc-400">
              Clinician accounts are manually enabled so the portal stays limited to validation, research, and supervised clinical workflows.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-heading font-bold">Why participate?</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {CLINICIAN_REASONS.map(reason => (
              <div key={reason.title} className="rounded-2xl border border-white/[0.06] bg-surface/60 p-4">
                <h3 className="text-sm font-semibold text-zinc-100">{reason.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{reason.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-heading font-bold">Clinician portal features</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {PORTAL_FEATURES.map(feature => (
              <div key={feature.title} className="rounded-2xl border border-white/[0.06] bg-surface/60 p-4">
                <h3 className="text-sm font-semibold text-zinc-100">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{feature.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-heading font-bold">Validation priorities</h2>
          <ul className="space-y-3 text-sm leading-relaxed text-zinc-300">
            {VALIDATION_HELP.map(item => (
              <li key={item} className="flex gap-3">
                <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  )
}
