<p align="center">
  <img src=".github/assets/banner.png" alt="stella" width="100%" />
</p>

<p align="center">
  <strong>Legal workspace: free to use, open to inspect, yours to keep.</strong>
</p>

<p align="center">
  <a href="https://stll.app">Website</a> &middot;
  <a href="MANIFESTO.md">Manifesto</a> &middot;
  <a href="https://github.com/stella/stella/issues">Issues</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a> &middot;
  <a href="https://discord.gg/8dZjmVFjTK">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/stella/stella/releases"><img src="https://img.shields.io/github/v/release/stella/stella?include_prereleases&label=release" alt="Latest release" /></a>
  <a href="https://github.com/stella/stella/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License" /></a>
  <a href="https://stll.app"><img src="https://img.shields.io/badge/cloud-stll.app-black" alt="stella cloud" /></a>
  <a href="https://github.com/stella/stella/issues"><img src="https://img.shields.io/github/issues/stella/stella" alt="Issues" /></a>
  <a href="https://discord.gg/8dZjmVFjTK"><img src="https://img.shields.io/badge/discord-join%20chat-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

---

stella is an open-source legal workspace and data stack for legal teams,
currently in beta.

### Data infrastructure

**Case law and public legal sources.** [Legal Atlas](packages/legal-atlas)
collects and parses official legal material with source adapters, structure
preserving parsers, and ingestion primitives.

**Business registries.** [Business Registries](packages/business-registries)
provides typed clients for national company and commercial registries, including
ARES, Companies House, SEC EDGAR, KRS, PRH, VIES and more.

**Anonymization.** [stella/anonymize](https://github.com/stella/anonymize)
provides WASM-backed anonymization tooling for legal AI workflows, with app
integration through chat and document review.

### Legal intelligence

**Tabular Review.** Extract structured answers from document sets into
matter-scoped review tables for due diligence, discovery and research.

**AI agent.** Chat with matters, files, registries and connected tools, with
approvals and source previews.

**Skills and external connectors.** Reusable prompts, tool definitions and
MCP-compatible tools that extend the agent.

### Workspace

**Web app.** Matters, documents, Word .docx editing, review, research, chat and
knowledge tools in one workspace.

**Desktop app.** Local desktop bridge for editing Office documents from stella.

**[stella MCP server](apps/api/src/mcp/README.md).** A central gateway to
access and control stella data, including matters, documents and case law.

**Outlook add-in.** Coming soon.

## Quickstart

### stella cloud

Hosted stella preview is available at [my.stll.app](https://my.stll.app).

### Self-hosting

Run stella on your own infrastructure with the
[self-hosting guide](apps/docs/src/content/docs/guides/self-hosting.md). The
self-host Compose file runs the API and Gotenberg only; configure Postgres,
Redis or Valkey, S3-compatible storage, `GOTENBERG_URL`, and Gotenberg
credentials in `apps/api/.env`. The frontend is a TanStack Start SSR app:
build and run `apps/web/Dockerfile`, or run `bun --filter @stll/web build`
followed by `HOST=0.0.0.0 PORT=3002 bun apps/web/start-runtime.js`.

### Prerequisites

- Bun
- Git
- Docker Desktop or Docker Engine

### Run stella locally

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

stella does not aim to replace human judgment or provide legal advice. stella
relies on AI models, which can produce incorrect or misleading output. We aim
to ground AI flows in citations and traceable source material, but we encourage
users to always validate the answers.

## Contributing

We welcome contributions. You can help not only by writing code, but also, e.g., by
providing feedback, or translating. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for
more information and our policy on AI-generated contributions.

PRs must pass the linting and testing pipeline. You will be prompted
to sign the Contributor License Agreement (CLA) by CI.

## Contact

1. Open an issue for questions, feedback or suggestions.
2. Reach out to us for general queries at [hello@stll.app](mailto:hello@stll.app).
3. [security@stll.app](mailto:security@stll.app) for security issues
   (see [Security Policy](SECURITY.md)).

## Licensing

Licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the full
license text and [NOTICE](NOTICE) for attribution of bundled third-party code.

## Development

- Workspace layout:
  `apps/*` contains runnable applications, `packages/*` contains shared or
  publishable packages, and every workspace package uses the `@stll/<name>`
  naming convention.
- [stella web app](/apps/web/README.md)
- [stella desktop app](/apps/desktop/README.md)
- [stella landing site](/apps/landing/README.md)
- [stella API](/apps/api/README.md)
