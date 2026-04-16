import { useState } from 'react'
import { BackButton } from './AccessibleNav'

interface Paper {
  authors: string
  title: string
  journal: string
  year: number
  doi?: string
  pmid?: string
  summary: string
}

interface Link {
  label: string
  url: string
  description: string
}

interface PaperGroup {
  id: string
  label: string
  description: string
  papers: Paper[]
}

const PAPER_GROUPS: PaperGroup[] = [
  {
    id: 'disease',
    label: 'Disease & Natural History',
    description: 'Understanding RP progression, scotoma patterns, and rates of visual field loss.',
    papers: [
      {
        authors: 'Hartong DT, Berson EL, Dryja TP',
        title: 'Retinitis pigmentosa',
        journal: 'The Lancet, 368(9549): 1795–1809',
        year: 2006,
        doi: '10.1016/S0140-6736(06)69740-7',
        summary:
          'The definitive modern review of RP covering genetics, pathophysiology, and clinical features. Describes the classic progression from night blindness to mid-peripheral ring scotoma expanding both centrally and peripherally.',
      },
      {
        authors: 'Berson EL',
        title: 'Retinitis pigmentosa. The Friedenwald Lecture',
        journal: 'Investigative Ophthalmology & Visual Science, 34(5): 1659–1676',
        year: 1993,
        doi: undefined,
        pmid: '8473105',
        summary:
          'Berson\'s landmark lecture summarizing decades of RP natural history research. Laid out the framework for understanding RP as a progressive rod-cone dystrophy with characteristic mid-peripheral scotoma patterns.',
      },
      {
        authors: 'Berson EL, Sandberg MA, Rosner B, Birch DG, Hanson AH',
        title: 'Natural course of retinitis pigmentosa over a three-year interval',
        journal: 'American Journal of Ophthalmology, 99(3): 240–251',
        year: 1985,
        doi: '10.1016/0002-9394(85)90351-4',
        summary:
          'One of the earliest large-scale longitudinal studies documenting the rate of visual field loss in RP. Established that patients lose roughly 4.6% of remaining field per year, becoming a benchmark figure across the literature.',
      },
      {
        authors: 'Birch DG, Anderson JL, Fish GE',
        title: 'Yearly rates of rod and cone functional loss in retinitis pigmentosa and cone-rod dystrophy',
        journal: 'Ophthalmology, 106(2): 258–268',
        year: 1999,
        doi: '10.1016/S0161-6420(99)90064-7',
        summary:
          'Used both ERG and perimetry to establish annual rates of photoreceptor loss. Demonstrated that rod loss precedes cone loss and visual field constriction follows a predictable exponential decay, critical for clinical trial endpoint design.',
      },
      {
        authors: 'Grover S, Fishman GA, Brown J Jr',
        title: 'Patterns of visual field progression in patients with retinitis pigmentosa',
        journal: 'Ophthalmology, 105(6): 1069–1075',
        year: 1998,
        doi: '10.1016/S0161-6420(98)96009-2',
        summary:
          'Systematically classified visual field loss patterns in RP using Goldmann perimetry. Identified ring scotomas as one of the most common early presentations and documented progression from partial arcuate scotomas to complete rings to concentric constriction.',
      },
    ],
  },
  {
    id: 'perimetry',
    label: 'Visual Field Testing & Perimetry',
    description: 'Research on Goldmann perimetry methodology, stimulus parameters, and digital perimetry validation.',
    papers: [
      {
        authors: 'Grover S, Fishman GA, Anderson RJ, Alexander KR, Derlacki DJ',
        title: 'Rate of visual field loss in retinitis pigmentosa',
        journal: 'Ophthalmology, 104(3): 460–465',
        year: 1997,
        doi: '10.1016/S0161-6420(97)30291-7',
        summary:
          'Quantified visual field loss rates using Goldmann perimetry, stratified by inheritance pattern. Showed that field loss is exponential rather than linear, with autosomal dominant RP progressing more slowly than X-linked forms.',
      },
      {
        authors: 'Swanson WH, Felius J, Birch DG',
        title: 'Effect of stimulus size on static visual fields in patients with retinitis pigmentosa',
        journal: 'Ophthalmology, 107(10): 1950–1954',
        year: 2000,
        doi: '10.1016/S0161-6420(00)00356-0',
        summary:
          'Demonstrated that stimulus size significantly affects scotoma detection in RP. Smaller stimuli reveal ring scotomas not detected with larger targets — directly relevant to why multi-stimulus testing (V4e through I2e) provides more complete field mapping.',
      },
      {
        authors: 'Ross DF, Fishman GA, Gilbert LD, Anderson RJ',
        title: 'Variability of visual field measurements in normal subjects and patients with retinitis pigmentosa',
        journal: 'Archives of Ophthalmology, 102(7): 1004–1010',
        year: 1984,
        doi: '10.1001/archopht.1984.01040030806021',
        summary:
          'Quantified test-retest variability of Goldmann perimetry in RP patients. Established that variability increases as fields constrict, with major implications for interpreting whether field changes represent real progression or measurement noise.',
      },
      {
        authors: 'Kong YXG, He M, Crowston JG, Vingrys AJ',
        title: 'A comparison of perimetric results from a tablet perimeter and Humphrey Field Analyzer in glaucoma patients',
        journal: 'Translational Vision Science & Technology, 5(6): 2',
        year: 2016,
        doi: '10.1167/tvst.5.6.2',
        summary:
          'Validated tablet-based perimetry (Melbourne Rapid Fields) against the Humphrey Field Analyzer. While focused on glaucoma, this foundational paper demonstrated that home-based perimetry can produce clinically meaningful results, directly relevant to RP self-monitoring.',
      },
    ],
  },
  {
    id: 'genetics',
    label: 'Genetics & Classification',
    description: 'Genetic subtypes, inheritance patterns, and genotype-phenotype correlations in RP.',
    papers: [
      {
        authors: 'Fishman GA',
        title: 'Retinitis pigmentosa: genetic percentages',
        journal: 'Archives of Ophthalmology, 96(5): 822–826',
        year: 1978,
        doi: '10.1001/archopht.1978.03910050428005',
        summary:
          'Early foundational paper establishing the genetic epidemiology of RP. X-linked RP was shown to have the most severe course with earliest visual field loss, while autosomal dominant cases had the mildest progression.',
      },
      {
        authors: 'Massof RW, Finkelstein D',
        title: 'Two forms of autosomal dominant primary retinitis pigmentosa',
        journal: 'Documenta Ophthalmologica, 51(4): 289–346',
        year: 1981,
        doi: '10.1007/BF00143336',
        summary:
          'Proposed a two-stage model of RP: diffuse rod sensitivity loss followed by regional field loss. Distinguished Type 1 (diffuse) from Type 2 (regional) patterns, providing an influential framework for understanding scotoma development.',
      },
      {
        authors: 'Sandberg MA, Rosner B, Weigel-DiFranco C, Dryja TP, Berson EL',
        title: 'Disease course in patients with autosomal recessive retinitis pigmentosa due to the USH2A gene',
        journal: 'Investigative Ophthalmology & Visual Science, 49(12): 5532–5539',
        year: 2008,
        doi: '10.1167/iovs.08-2009',
        summary:
          'One of the first genotype-specific natural history studies in RP. Showed that USH2A patients follow a relatively predictable pattern of visual field constriction, important for understanding how genetic subtype influences scotoma patterns.',
      },
      {
        authors: 'Verbakel SK, van Huet RAC, Boon CJF, et al.',
        title: 'Non-syndromic retinitis pigmentosa',
        journal: 'Progress in Retinal and Eye Research, 66: 157–186',
        year: 2018,
        doi: '10.1016/j.preteyeres.2018.03.005',
        summary:
          'Comprehensive modern review covering over 80 RP-associated genes, genotype-phenotype correlations, and the rapidly expanding genetic landscape. Provides an updated classification framework that supersedes older studies limited to a handful of known genes.',
      },
      {
        authors: 'Georgiou M, Fujinami K, Michaelides M',
        title: 'Inherited retinal diseases: therapeutics, clinical trials and end points — a review',
        journal: 'Clinical & Experimental Ophthalmology, 49(3): 270–288',
        year: 2021,
        doi: '10.1111/ceo.13917',
        summary:
          'Reviews the genetic architecture of inherited retinal diseases in the era of next-generation sequencing. Covers gene identification strategies, emerging genotype-phenotype insights, and how genetic diagnosis now directly informs treatment eligibility for gene therapies.',
      },
    ],
  },
  {
    id: 'treatments',
    label: 'Treatments & Interventions',
    description: 'Clinical trials, gene therapy, and neuroprotective approaches for RP.',
    papers: [
      {
        authors: 'Berson EL, Rosner B, Sandberg MA, et al.',
        title: 'A randomized trial of vitamin A and vitamin E supplementation for retinitis pigmentosa',
        journal: 'Archives of Ophthalmology, 111(6): 761–772',
        year: 1993,
        doi: '10.1001/archopht.1993.01090060049022',
        summary:
          'Landmark RCT (n=601) showing vitamin A palmitate slowed ERG decline. Included extensive Goldmann visual field data and established methodology for measuring RP progression that became the standard for clinical trials.',
      },
      {
        authors: 'Maguire AM, Simonelli F, Pierce EA, Pugh EN Jr, et al.',
        title: 'Safety and efficacy of gene transfer for Leber\'s congenital amaurosis',
        journal: 'New England Journal of Medicine, 358(21): 2240–2248',
        year: 2008,
        doi: '10.1056/NEJMoa0802315',
        summary:
          'The landmark gene therapy trial for LCA2 (RPE65 mutations). Used Goldmann perimetry as a key outcome measure, demonstrating visual field expansion after treatment — proving that RP-related field loss can potentially be reversed.',
      },
      {
        authors: 'Jacobson SG, Cideciyan AV',
        title: 'Treatment possibilities for retinitis pigmentosa',
        journal: 'New England Journal of Medicine, 363(17): 1669–1671',
        year: 2010,
        doi: '10.1056/NEJMcibr1007685',
        summary:
          'Influential editorial summarizing the state of knowledge about RP progression and what endpoints — including visual field area — matter most for evaluating emerging gene therapies and neuroprotective treatments.',
      },
      {
        authors: 'Sahel JA, Boulanger-Scemama E, Pagot C, et al.',
        title: 'Partial recovery of visual function in a blind patient after optogenetic therapy',
        journal: 'Nature Medicine, 27(7): 1223–1229',
        year: 2021,
        doi: '10.1038/s41591-021-01351-4',
        summary:
          'First report of partial vision restoration using optogenetic therapy (ChrimsonR) in a patient with advanced RP. The patient regained the ability to perceive and locate objects — a landmark proof-of-concept for gene-agnostic approaches that bypass dead photoreceptors entirely.',
      },
      {
        authors: 'Stingl K, Bartz-Schmidt KU, Besch D, et al.',
        title: 'Subretinal visual implant Alpha IMS — clinical trial interim report',
        journal: 'Vision Research, 111(Pt B): 149–160',
        year: 2015,
        doi: '10.1016/j.visres.2015.03.001',
        summary:
          'Clinical trial of the Alpha IMS subretinal implant restoring light perception and object recognition in blind RP patients. Demonstrated that electronic retinal prostheses can partially substitute for lost photoreceptors in end-stage disease.',
      },
      {
        authors: 'Cehajic-Kapetanovic J, Xue K, Martinez-Fernandez de la Camara C, et al.',
        title: 'Initial results from a first-in-human gene therapy trial on X-linked retinitis pigmentosa caused by mutations in RPGR',
        journal: 'Nature Medicine, 26(3): 354–359',
        year: 2020,
        doi: '10.1038/s41591-020-0763-1',
        summary:
          'First-in-human gene therapy trial for RPGR X-linked RP, the most severe genetic form. Showed improved retinal sensitivity and visual field gains in treated eyes, extending gene therapy beyond RPE65-associated disease to a broader RP population.',
      },
      {
        authors: 'Dias MF, Joo K, Kemp JA, et al.',
        title: 'Molecular genetics and emerging therapies for retinitis pigmentosa: basic research and clinical perspectives',
        journal: 'Progress in Retinal and Eye Research, 63: 107–131',
        year: 2018,
        doi: '10.1016/j.preteyeres.2017.10.004',
        summary:
          'Broad review linking genetic discoveries to therapeutic strategies including gene replacement, optogenetics, stem cells, and neuroprotection. Provides context for how rapidly the treatment landscape has evolved from vitamin A supplementation to gene-specific interventions.',
      },
    ],
  },
]

const LINKS: Link[] = [
  {
    label: 'Foundation Fighting Blindness',
    url: 'https://www.fightingblindness.org/',
    description: 'Largest US organization funding RP research. Maintains a clinical trial pipeline tracker.',
  },
  {
    label: 'Retina UK (formerly RP Fighting Blindness)',
    url: 'https://www.retinauk.org.uk/',
    description: 'UK-based charity with patient resources, community forums, and research funding.',
  },
  {
    label: 'Retina International',
    url: 'https://www.retina-international.org/',
    description: 'Global umbrella organization connecting retinal degeneration patient groups worldwide.',
  },
  {
    label: 'National Eye Institute — RP',
    url: 'https://www.nei.nih.gov/learn-about-eye-health/eye-conditions-and-diseases/retinitis-pigmentosa',
    description: 'Authoritative clinical information on RP from the US National Institutes of Health.',
  },
  {
    label: 'ClinicalTrials.gov — RP',
    url: 'https://clinicaltrials.gov/search?cond=Retinitis+Pigmentosa',
    description: 'Search active and completed clinical trials for retinitis pigmentosa treatments.',
  },
  {
    label: 'ISCEV Standards',
    url: 'https://iscev.wildapricot.org/',
    description: 'International Society for Clinical Electrophysiology of Vision — publishes ERG and perimetry testing standards.',
  },
  {
    label: 'My Retina Tracker (FFB)',
    url: 'https://www.fightingblindness.org/my-retina-tracker-registry',
    description: 'Patient registry by Foundation Fighting Blindness for tracking diagnosis, genetic testing, and clinical trial matching.',
  },
]

interface Props {
  onBack: () => void
}

export function ScienceReferences({ onBack }: Props) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const togglePaper = (key: string) => setExpandedKey(expandedKey === key ? null : key)

  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <div className="max-w-3xl mx-auto space-y-8 pb-12">
        <div className="flex items-center justify-between pb-5 border-b border-white/[0.06]">
          <h1 className="text-3xl font-heading font-bold">Scientific References</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        <p className="text-zinc-400 text-sm leading-relaxed">
          Key scientific papers on visual field testing, scotoma patterns, and disease progression in retinitis pigmentosa.
          These references provide the clinical basis for the testing methodology used in this app.
        </p>

        {/* Grouped papers */}
        {PAPER_GROUPS.map(group => (
          <div key={group.id} className="space-y-3">
            <div>
              <h3 className="text-lg font-heading font-semibold text-zinc-200">{group.label}</h3>
              <p className="text-xs text-zinc-500 mt-0.5">{group.description}</p>
            </div>
            {group.papers.map((p, i) => {
              const key = `${group.id}-${i}`
              const isExpanded = expandedKey === key
              return (
                <button
                  key={key}
                  onClick={() => togglePaper(key)}
                  className="w-full text-left bg-surface hover:bg-elevated rounded-2xl px-4 py-3 transition-all border border-white/[0.06] hover:border-white/[0.1]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-white font-medium leading-snug">{p.title}</p>
                      <p className="text-xs text-zinc-500 mt-1">
                        {p.authors} — <span className="text-zinc-600">{p.journal} ({p.year})</span>
                      </p>
                    </div>
                    <span className={`text-zinc-600 text-xs shrink-0 mt-1 transition-transform ${isExpanded ? 'rotate-90' : ''}`}>
                      &#9654;
                    </span>
                  </div>
                  {isExpanded && (
                    <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
                      <p className="text-sm text-zinc-300 leading-relaxed">{p.summary}</p>
                      {p.doi && (
                        <a
                          href={`https://doi.org/${p.doi}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="inline-block text-xs text-accent hover:text-accent-light transition-colors"
                        >
                          DOI: {p.doi} &rarr;
                        </a>
                      )}
                      {!p.doi && p.pmid && (
                        <a
                          href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="inline-block text-xs text-accent hover:text-accent-light transition-colors"
                        >
                          PubMed: {p.pmid} &rarr;
                        </a>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        ))}

        {/* Links */}
        <div className="space-y-3">
          <h3 className="text-lg font-heading font-semibold text-zinc-200">Useful resources</h3>
          {LINKS.map((link, i) => (
            <a
              key={i}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-surface hover:bg-elevated rounded-2xl px-4 py-3 transition-all border border-white/[0.06] hover:border-white/[0.1]"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-accent font-medium">{link.label}</span>
                <span className="text-zinc-600 text-xs">&rarr;</span>
              </div>
              <p className="text-xs text-zinc-500 mt-1">{link.description}</p>
            </a>
          ))}
        </div>

        {/* Disclaimer */}
        <p className="text-xs text-zinc-600 leading-relaxed">
          This reference list is not exhaustive. Papers were selected for their foundational importance to the field of RP visual field testing.
          Always consult your ophthalmologist for clinical decisions.
        </p>
      </div>
    </main>
  )
}
