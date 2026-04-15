# Contributing to Stella

Thank you for considering a contribution to Stella. Whether you are
reporting a bug, suggesting a feature, improving documentation, or
writing code, your help is welcome.

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies: `bun install`
3. (Optional) Set up Claude Code docs server: `bun run setup:mcp`
4. Start the dev environment: `bun run dev`

`bun run dev` now prepares the local stack for the current checkout,
including worktree-aware `.env` linking and automatic port offsets when
the default ports are already taken. Use `bun run dev:web` or
`bun run dev:api` for a focused loop, `bun run dev:desktop` to launch the
desktop app alongside web and API, or `bun run dev:all` for the raw
Turborepo fan-out. Web-facing modes auto-open the app in your browser;
pass `-- --no-browser` to skip that.

See the [README](README.md) for the full tech stack and project
structure.

### Claude Code LSP (experimental)

The project enables the TypeScript LSP plugin for Claude Code
(`.claude/settings.json`), giving Claude go-to-definition,
find-references, hover types, and auto-diagnostics. The plugin
has a known race condition
([#29858](https://github.com/anthropics/claude-code/issues/29858))
and may not load reliably. To try it:

1. Install the language server binary:
   ```bash
   npm install -g typescript-language-server typescript
   ```
2. Add to your `~/.claude/settings.json`:
   ```json
   {
     "env": { "ENABLE_LSP_TOOL": "1" }
   }
   ```

If the LSP tool doesn't appear after restart, use Glob/Grep
to explore the codebase.

## Workspace Layout

- `apps/*` contains runnable applications only.
- `packages/*` contains shared or publishable packages only.
- Every direct child of `apps/` and `packages/` is a workspace package named
  `@stella/<directory>`.
- Use scoped workspace filters in commands, for example
  `bun --filter @stella/web dev`.

## Development Workflow

1. Create a branch from `main` for your changes.
2. Make your changes, following the conventions below.
3. Run checks before pushing:
   ```bash
   bun run lint && bun run format && bun run typecheck && bun run test
   ```
4. Open a pull request against `main`.
5. Fill in the PR template and link a related issue.

## AI Commands

Stella uses a layered AI command setup:

```text
.ai/shared/              # shared AI repo submodule
.ai/local-skills/        # Stella-specific Codex-style skill source
.claude/commands/        # generated flat command files
.agents/skills/          # generated Codex-style skills
```

Do not hand-edit `.claude/commands/` or `.agents/skills/`;
they are generated from the shared and local sources.

The sync layout is:

```text
.ai/local-skills/<skill>/SKILL.md
.claude/commands/<skill>.md
.agents/skills/<skill>/SKILL.md
```

To refresh them:

```bash
git submodule update --init
bun run sync-ai
```

To expose the generated agent skills in Codex's `/` picker:

```bash
bun run link-codex
```

This links `.agents/skills/<skill>/SKILL.md` into
`${CODEX_HOME:-$HOME/.codex}/skills` using a safe default
prefix (`stella-`). Set `CODEX_SKILL_PREFIX=""` if you want
unprefixed global names.

## Conventions

- **Commits**: use [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `chore:`, `docs:`).
- **TypeScript**: strict mode, `type` over `interface`, no `any`,
  no non-null assertions. See [CLAUDE.md](CLAUDE.md) for full
  coding conventions.
- **Linting**: oxlint (ultracite preset). **Formatting**: oxfmt.
- **Tests**: write tests for new functionality when applicable.

## Pull Request Checklist

- [ ] Code builds without errors or warnings
- [ ] Changes are tested
- [ ] CLA is signed
- [ ] Issue is linked

## Contributor License Agreement

All contributors must sign the
[Contributor License Agreement](https://github.com/stella/cla/blob/main/CLA.md) before their pull request
can be merged. You will be prompted automatically when you open a
PR. Signing is a one-time process: post the required comment on
your first PR and all future contributions are covered.

The CLA grants stella labs, s.r.o. a perpetual license to use your
contributions. This is necessary because Stella is dual-licensed
(AGPL-3.0 and a commercial license).

## AI-Generated Contributions

We accept AI-assisted contributions. You remain responsible for
reviewing and understanding any AI-generated code you submit. The
CLA applies equally to AI-assisted contributions: you must have the
legal right to submit them.

## Reporting Bugs

Open an [issue](https://github.com/stella/stella/issues) with
steps to reproduce, expected behavior, and actual behavior.

## Security Issues

Do **not** open a public issue for security vulnerabilities.
Instead, email [security@stll.app](mailto:security@stll.app).
See [SECURITY.md](SECURITY.md) for details.

## Questions?

Open an issue or email [hello@stll.app](mailto:hello@stll.app).
