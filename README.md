# OpenPerimetry

A free, open-source visual field self-test. Run Goldmann-style kinetic perimetry at home, track your field over time, and export results as standardised [OVFX](https://github.com/openperimetry/ovfx-spec) documents or PDF reports.

**Not a medical device.** Always consult your ophthalmologist for diagnosis and treatment. See the in-app [clinical disclaimer](web/src/components/ClinicalDisclaimer.tsx) for the full statement.

Hosted-instance operators can configure their own public URL and branding.

## What it does

- **Kinetic perimetry (Goldmann)** — moving stimuli with V4e / III4e / III2e / I4e / I2e at standardised brightness levels, with adaptive refinement, boundary tracing, and outlier retest
- **Static threshold perimetry** — density-weighted hex grid with automatic scotoma tracing and multi-level luminance
- **Ring perimetry** — experimental ring-based variant for ring scotoma mapping
- **Calibration** — screen size (bank-card reference), brightness floor, viewing distance, reaction time
- **Results** — isopter maps, area calculations, clinical interpretation with severity + pattern modifiers (ring scotoma, asymmetry), PDF export
- **1:1 verify overlay** — renders isopter boundaries at actual screen size with stimulus-weight mode (stroke = stimulus diameter and luminance)
- **Vision simulator** — visualises what the user sees through their own recorded field
- **History & trends** — local-first storage with optional account-based cloud sync
- **OVFX export/import** — interoperable data exchange via the open [OVFX spec](https://github.com/openperimetry/ovfx-spec)

## Quick start

### Docker (recommended)

```bash
docker compose up --build
# Web → http://localhost:5173
# API → http://localhost:8787
```

The compose stack runs an SQLite-backed API with console email (no AWS credentials needed).

### Manual

```bash
# API
cd api
cp .env.example .env
npm install
npm run dev                    # → http://localhost:8787

# Web (separate shell)
cd web
cp .env.example .env.local
npm install
npm run dev                    # → http://localhost:5173
```

### End-to-end tests

```bash
cd web
npx playwright install chromium   # first time
npx playwright test
```

## Repository structure

```
web/            React 19 + TypeScript + Vite 7 frontend (Tailwind CSS)
api/            Node + Express backend (SQLite dev, optional DynamoDB prod)
docker-compose.yml   One-command local dev stack
```

## Configuration

All configuration is env-driven with safe defaults for local development.

| File | What it controls |
|------|-----------------|
| `api/.env.example` | Backend: storage backend, email backend, rate limits, auth cookies |
| `web/.env.example` | Frontend: API URL, branding (app name, domain, support email), analytics |

### Branding

Fork or hosted-instance operators can rebrand by setting `VITE_APP_NAME`, `VITE_APP_URL`, `VITE_APP_DOMAIN`, and `VITE_SUPPORT_EMAIL` at build time. Defaults resolve to "OpenPerimetry" at localhost. See [`web/src/branding.ts`](web/src/branding.ts) for the full surface.

### Storage backends

- **sqlite** (default) — zero-config, data stored in `api/data/local.sqlite`. Great for local dev and small self-hosted deployments.
- **dynamodb** — optional production backend. Requires AWS credentials + DynamoDB tables. The open-source distribution includes the client code but it's loaded lazily and never evaluated when `STORAGE_BACKEND=sqlite`.

### Email backends

- **console** (default) — prints emails to stdout. Fine for local dev.
- **ses** — AWS SES for production email delivery. Requires `SES_REGION` + a verified sending domain.

### Shareable test settings

Casual users get clinically-grounded defaults for catch-trial cadence, fixation-loss alert, speed-preset timings, and background shade. Advanced users (researchers, clinicians running custom protocols, tinkerers) can tweak these from the **Advanced test settings (optional)** panel on the calibration *Screen calibration* step (below the field-coverage preview), export the result as a small JSON file, and share it with others.

Settings are stored in `localStorage` under the key `vfc-advanced-settings`, so any override persists per-browser across sessions.

**File format (version 1.x):**

```json
{
  "vfcSettingsVersion": "1.0.0",
  "generatedAt": "2026-04-18T10:00:00.000Z",
  "settings": {
    "catchTrialEveryN": 7,
    "fixationAlertMs": 1500,
    "fixationAlertMessage": "Keep your eye on the fixation point",
    "speedPreset": {
      "override": false,
      "stimulusMs": 500,
      "responseMs": 1400,
      "gapMinMs": 350,
      "gapMaxMs": 650
    },
    "backgroundShade": "dark"
  }
}
```

- `settings` carries every field — not just the ones that differ from defaults — so the file doubles as a discoverable schema. A recipient can open the JSON and immediately see every knob they could turn.
- The import path also accepts partial settings (old exports, hand-written files), filling in defaults for anything left out.
- The import path requires `vfcSettingsVersion` to start with `"1."` so forward-compatible minor additions (new fields) won't break the parser, but an incompatible major bump will refuse to load.
- The on-device `localStorage` copy (key `vfc-advanced-settings`) is still stored compactly — only non-default fields are written there, since storage is an implementation detail and small saves are fast.
- See [`web/src/advancedSettings.tsx`](web/src/advancedSettings.tsx) for the authoritative shape and validation rules.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

## Related projects

- [OVFX spec](https://github.com/openperimetry/ovfx-spec) — the open data interchange format for visual field results used by this project

## Related tools and where this project stands

Browser-based and consumer visual-field self-tests are a small but growing space. The table below positions OpenPerimetry against the tools most often cited alongside it:

| Tool | Platform | Test type | Threshold model | Open source | Validation |
|---|---|---|---|---|---|
| [HFA (Humphrey)](https://www.zeiss.com/meditec/en/products/ophthalmology/humphrey-field-analyzer-3.html) | Clinical perimeter | 24-2 / 30-2 / 10-2 SITA | Bayesian (SITA) | No | Clinical gold standard |
| [Specvis Desktop](https://github.com/piotrdzwiniel/Specvis-Desktop) | Windows / macOS / Linux (JRE 8) | Static, 48/96 pts | Staircase (length 9/13/17) | Yes (BSD) | [PLoS ONE 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5640235/) vs Medmont M700 |
| [Peristat Online](http://www.perimetry.org/) | Web — any monitor | Static suprathreshold, 4 levels | Suprathreshold only | No | 80–86% sens, 94–97% spec vs HFA |
| [Visual Fields Easy](https://apps.apple.com/app/visual-fields-easy/id719415275) | iPad | Static suprathreshold, 96 pts | Single-level suprathreshold | No | Inadequate for one-time home screen (2022 UK study) |
| **OpenPerimetry** (this project) | Web — any browser | **Goldmann kinetic + static + ring-scotoma** | Fixed Goldmann isopter intensities | Yes (Apache 2.0) | **Not yet validated against a clinical perimeter.** |

**What this tool is good for:** tracking your own field over time (especially kinetic isopters in retinitis pigmentosa, scotoma boundary changes, or gross binocular coverage), getting a sense of whether anything looks unusual, and sharing a PDF with an eye care professional.

**What it is not:** a substitute for Humphrey, Octopus, or Medmont perimetry; a glaucoma-screening tool; a diagnostic device. If results suggest a defect, follow up with an ophthalmologist for a clinical test on a calibrated perimeter.

**Distinctives vs the others in the list:**
- Only tool offering Goldmann-style **kinetic isopters** (V4e / III4e / III2e / I4e / I2e) in the browser.
- Only tool with an explicit **ring-scotoma tracing test**.
- Zero install: runs on any modern browser on any monitor.
- Ships Reliability Indices (Fixation Accuracy and False-Positive Response Rate) per the Specvis / HFA convention, with reference ranges from [Dzwiniel et al., PLoS ONE 2017](https://pmc.ncbi.nlm.nih.gov/articles/PMC5640235/).
