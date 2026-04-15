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

## Getting started

### Stella Cloud

Register for free at [stll.app](https://stll.app).

### Self-hosting

[ to be added ]

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
  publishable packages, and every workspace package uses the `@stella/<name>`
  naming convention.
- [Stella Web App](/apps/web/README.md)
- [Stella Desktop App](/apps/desktop/README.md)
- [Stella Landing Site](/apps/landing/README.md)
- [Stella API](/apps/api/README.md)
- [InfoSoud SDK](/packages/infosoud/README.md)
