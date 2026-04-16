import { BackButton } from './AccessibleNav'

interface Props {
  onBack: () => void
}

export function AboutPage({ onBack }: Props) {
  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <div className="max-w-3xl mx-auto space-y-10 pb-12">
        <div className="flex items-center justify-between pb-5 border-b border-white/[0.06]">
          <h1 className="text-3xl font-heading font-bold">About</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        {/* Photo */}
        <div className="rounded-2xl overflow-hidden border border-white/[0.06]">
          <img
            src="/images/daniel-tom.jpg"
            alt="Daniël Tom and his wife in Tuscany"
            className="w-full object-cover max-h-[360px]"
          />
        </div>

        {/* Intro */}
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-heading font-bold">Daniël Tom</h2>
            <p className="text-zinc-400 text-sm">36 years old &middot; The Hague, Netherlands</p>
          </div>

          <p className="text-zinc-300 leading-relaxed">
            Hi, I'm Daniël. I was diagnosed with <strong className="text-white">Usher syndrome
            type 2a</strong> when I was 20. I've had moderate hearing loss since birth, and
            retinitis pigmentosa crept in during my teens &mdash; first as night blindness, then as
            a steady loss of peripheral vision through my twenties.
          </p>

          <p className="text-zinc-300 leading-relaxed">
            Fifteen years on, my visual field shows <strong className="text-white">moderate RP with
            an asymmetric ring scotoma</strong>: a band of lost vision in the mid-periphery, with
            central sight and some far-peripheral vision still intact. Below is one of my own test
            results.
          </p>
        </div>

        {/* VF result image */}
        <div className="rounded-2xl overflow-hidden border border-white/[0.06]">
          <img
            src="/images/daniel-vf-result.png"
            alt="Daniël's visual field test result showing moderate RP with ring scotoma"
            className="w-full"
          />
        </div>

        {/* Why I built this */}
        <div className="space-y-4">
          <h2 className="text-lg font-heading font-bold">Why I built this</h2>

          <p className="text-zinc-300 leading-relaxed">
            I built this tool for myself, first and foremost. I wanted a way to map and track my
            visual field at home &mdash; between clinical appointments &mdash; and to show my wife
            what I actually see. The vision simulator in the test results came straight from that
            need: describing tunnel vision is one thing, <em>seeing</em> it is another.
          </p>

          <p className="text-zinc-300 leading-relaxed">
            Clinical Goldmann perimetry is the gold standard, but appointments are months apart and
            the results stay locked in hospital files. I wanted something I could run on my own
            screen, on my own schedule, and compare over time. If it helps other RP patients
            too &mdash; even better.
          </p>
        </div>

        {/* Personal */}
        <div className="space-y-4">
          <h2 className="text-lg font-heading font-bold">Outside of this</h2>

          <p className="text-zinc-300 leading-relaxed">
            By day I work as a Data Engineer consultant. The rest of my time goes to my
            family &mdash; mostly chasing a soccer ball with my 2.5-year-old son &mdash; and
            side projects like this one. I'm curious about physics and love building things where
            science meets engineering.
          </p>
        </div>

        {/* Contact / closing */}
        <div className="bg-surface rounded-2xl p-6 space-y-2 border border-white/[0.06]">
          <p className="text-sm text-zinc-300">
            This tool is free and open. If you have questions, suggestions, or just want to say
            hi &mdash; I'd love to hear from you.
          </p>
          <p className="text-sm text-zinc-500">
            Built with care in The Hague, for anyone who needs it.
          </p>
        </div>
      </div>
    </main>
  )
}
