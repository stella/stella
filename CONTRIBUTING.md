# Contributing to Stella

Thank you for considering a contribution to Stella. Whether you are
reporting a bug, suggesting a feature, improving documentation, or
writing code, your help is welcome.

## Getting Started

1. Fork the repository and clone your fork.
2. Install dependencies: `bun install`
3. (Optional) Set up Claude Code docs server: `bun run setup:mcp`
4. Start the dev environment: `bun run dev`

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

If the LSP tool doesn't appear after restart, Claude falls
back to [CODEBASE.md](CODEBASE.md) for navigation.

## Development Workflow

1. Create a branch from `main` for your changes.
2. Make your changes, following the conventions below.
3. Run checks before pushing:
   ```bash
   bun run lint && bun run format && bun run typecheck && bun run test
   ```
4. Open a pull request against `main`.
5. Fill in the PR template and link a related issue.

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
