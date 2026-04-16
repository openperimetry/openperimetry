# Security

OpenPerimetry handles authentication, stores test results, and, in
hosted deployments, processes personal data. We take security
seriously.

## Reporting a vulnerability

Please report security issues **privately** via GitHub Security
Advisories:

<https://github.com/openperimetry/openperimetry/security/advisories/new>

Please do **not** open a public issue, PR, or discussion for
suspected security problems. We will acknowledge receipt within 7
days and aim to publish a fix within 30 days for confirmed issues.

Safe-harbour: we welcome good-faith security research. As long as
you report privately, avoid accessing other users' data, and give us
reasonable time to fix the issue before public disclosure, we will
not pursue legal action.

## What counts as a security issue

- Authentication / authorisation bypass
- SQL injection, command injection, path traversal
- Cross-site scripting (XSS), CSRF, clickjacking
- Session-handling bugs (cookie leak, token reuse)
- Secrets or PII leaking into logs, error messages, or telemetry
- Dependency vulnerabilities with a clear exploit path in our usage

## What does NOT count

- The app is NOT a medical device and does not claim diagnostic
  accuracy. Disagreements with the clinical interpretation are
  feature requests, not vulnerabilities.
- The visual-field data itself is self-reported and can be gamed by
  the user testing themselves; that is inherent to a self-test and
  is not a security bug.
- Old versions. Please verify the issue still exists on `main`
  before reporting.

## Scope

Only the code in this repository is in scope. If the hosted instance
at a specific URL exposes an issue caused by custom deploy
configuration, report it directly to that deployment's operator.
