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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.

## Related projects

- [OVFX spec](https://github.com/openperimetry/ovfx-spec) — the open data interchange format for visual field results used by this project
