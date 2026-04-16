# Contributing to OpenPerimetry

Thank you for considering a contribution. OpenPerimetry is a free,
open-source visual field self-test and we welcome improvements from
developers, clinicians, and patients alike.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
By participating you agree to uphold its standards. Harassment,
discrimination, or abusive behaviour are not tolerated.

## How to report a bug

Open a GitHub issue with:

- A clear description of the problem and what you expected instead.
- Steps to reproduce. For visual-field bugs, the exported `.ovfx.json`
  file from the affected test is the single most useful attachment.
- Browser + OS (Goldmann / ring / static tests are all browser-based).
- A screenshot if the issue is visual.

Do **not** open a public issue for security problems — see
[SECURITY.md](SECURITY.md) instead.

## How to propose a change

1. Open an issue describing the problem first. For anything beyond a
   typo, we prefer to agree on the approach before you write code.
2. Fork, branch, commit, and open a pull request targeting `main`.
3. One concern per PR. Mixing refactoring with a behaviour change
   makes reviews much harder.

## Development setup

```bash
git clone https://github.com/openperimetry/openperimetry
cd openperimetry
cp api/.env.example api/.env
cp web/.env.example web/.env.local

# Install and run the two services in separate shells:
cd api && npm install && npm run dev     # → http://localhost:8787
cd web && npm install && npm run dev     # → http://localhost:5173
```

Or use Docker Compose:

```bash
docker compose up --build
```

## Code style

- TypeScript, strict mode. `npx tsc --noEmit` must pass before opening
  a PR. CI runs `tsc -b` + `vite build` + `eslint` and will block on
  any of those.
- Prefer editing existing files over adding new ones. The codebase
  has a moderate amount of structural opinion — follow the surrounding
  style.
- **Clinical constants** (thresholds, stimulus sizes, Fourier fit
  parameters) live in `web/src/constants.ts`,
  `web/src/clinicalClassifications.ts`, and `web/src/isopterCalc.ts`.
  Do not tweak these without a clinical justification. When in doubt,
  open an issue before changing a clinical number.
- **Branding** strings go through `web/src/branding.ts`. Do not
  hardcode product names, URLs, or support addresses in new code.

## Tests

Playwright end-to-end tests live in `web/e2e/`. Run with
`cd web && npx playwright test`. New features that touch user-facing
flows should add at least one e2e.

## Clinical changes

Visual-field thresholds, classifications, and the interpretation
logic encode clinical convention. Changes to these files require:

- A linked issue with rationale (ideally citing a publication).
- A note in the PR description describing how the change was
  validated (e.g. against a reference implementation or a known test
  case).
- If the change affects exported PDFs or OVFX documents, an example
  file before and after.

## OVFX spec changes

The OVFX data interchange format lives in its own repository:
<https://github.com/openperimetry/ovfx-spec>. Spec changes go there,
not here.

## Licence

By contributing you agree that your contributions will be licensed
under the same [Apache License 2.0](LICENSE) that covers the rest of
the project.
