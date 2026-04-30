<p align="center">
  <img src=".github/assets/banner.png" alt="Stella" width="100%" />
</p>

<p align="center">
  <strong>Legal workspace: free to use, open to inspect, yours to keep.</strong>
</p>

<p align="center">
  <a href="https://stll.app">Website</a> &middot;
  <a href="MANIFESTO.md">Manifesto</a> &middot;
  <a href="https://github.com/stella/stella/issues">Issues</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/stella/stella/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://stll.app"><img src="https://img.shields.io/badge/cloud-stll.app-black" alt="Stella Cloud" /></a>
  <a href="https://github.com/stella/stella/issues"><img src="https://img.shields.io/github/issues/stella/stella" alt="Issues" /></a>
</p>

---

Stella is an open-source workspace for legal teams. Matters, documents, search — free forever. AI-powered review and research — paid by usage. No lock-in, no per-seat licensing, no hidden pricing.

Currently in beta.

## Features

**Matters.** Organize your practice around matters. Track status,
deadlines, parties and related documents in one place.

**Documents.** Store, search and manage files across your organization.
Full-text search, versioning and granular access control included. Free
forever.

**Review.** Analyze thousands of files at scale. Tabular Review pulls
structured data from documents using basic prompts or more complex
logical extensions. Built for due diligence, discovery and research.

**Research.** Find relevant laws, cases or doctrinal materials. Research
Agent searches external sources and returns what you need with
references.

## Quickstart

### Prerequisites

- Bun 1.3.12
- Git
- Docker Desktop or Docker Engine

For hosted Stella, register at [stll.app](https://stll.app).

### Run Stella locally

```bash
git clone https://github.com/stella/stella.git
cd stella
bun run dev
```

This installs dependencies, prepares local env files, starts Docker services,
pushes the database schema, starts the API at <http://localhost:3001>, starts
the web app at <http://localhost:3000>, and opens the browser.

### Optional demo data

```bash
bun --filter @stll/api db:seed-test-user
bun --filter @stll/api db:seed-dev
```

### Common commands

```bash
# Run only the web app, reusing an existing API
bun run dev:web

# Run only the API and local infrastructure
bun run dev:api

# Run without opening a browser
bun run dev --no-browser

# Skip setup steps when iterating
bun run dev --skip-install
bun run dev --skip-db-push

# Use shifted ports for parallel worktrees
bun run dev --dev-instance feature-a
```

Local development uses mock AI by default. To use real AI, set provider keys in
`apps/api/.env` and set `USE_MOCK_AI="false"`.

## Responsible use

The legal profession has ethical obligations that predate software by
centuries. We design around them from the start.

Stella relies on AI models, which can produce incorrect or misleading
output. AI-powered flows are grounded by citations and traceable to
source material, but we encourage users to always validate the answers.

## Contributing

We welcome contributions. You can help not only by writing code, but also by providing
feedback, or translating. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for more
information and our policy on AI-generated contributions.

PRs must pass the linting and testing pipeline. You will be prompted
to sign the Contributor License Agreement (CLA) by CI.

## Contact

1. Open an issue for questions, feedback or suggestions.
2. Reach out to us for general queries at [hello@stll.app](mailto:hello@stll.app).
3. [security@stll.app](mailto:security@stll.app) for security issues
   (see [Security Policy](SECURITY.md)).

## Licensing

Dual-licensed:

1. **AGPL v3** — open-source use. See [LICENSE](LICENSE).
2. **Commercial** — for proprietary use cases where the AGPL is not
   appropriate. Contact [hello@stll.app](mailto:hello@stll.app).

## Development

- Workspace layout:
  `apps/*` contains runnable applications, `packages/*` contains shared or
  publishable packages, and every workspace package uses the `@stll/<name>`
  naming convention.
- [Stella Web App](/apps/web/README.md)
- [Stella Desktop App](/apps/desktop/README.md)
- [Stella Landing Site](/apps/landing/README.md)
- [Stella API](/apps/api/README.md)
- [InfoSoud SDK](/packages/infosoud/README.md)
