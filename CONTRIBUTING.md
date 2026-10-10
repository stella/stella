# Contributing to Stella

Thank you for considering a contribution to Stella. Whether you are
reporting a bug, suggesting a feature, improving documentation, or
writing code, your help is welcome.

Please join our [Discord](https://discord.gg/8dZjmVFjTK) to discuss
and coordinate development.

## Getting Started

1. Install [Bun](https://bun.sh) at the version pinned in the
   `packageManager` field of `package.json`, and Docker (the local stack
   runs its services in containers).
2. Fork the repository and clone your fork with its submodules:
   `git clone --recurse-submodules <your fork URL>` (in an existing clone,
   run `git submodule update --init`).
3. Add the canonical repository as a remote, so local checks compare your
   branch against its `main` rather than your fork's:
   `git remote add upstream https://github.com/stella/stella.git && git fetch upstream`
4. Install dependencies: `bun install`
5. (Optional) Set up the documentation MCP server: `bun run setup:mcp`
6. Start the dev environment: `bun run dev`

`bun run dev` now prepares the local stack for the current checkout,
including worktree-aware `.env` linking and automatic port offsets when
the default ports are already taken. Use `bun run dev:web` or
`bun run dev:api` for a focused loop, `bun run dev:desktop` to launch the
desktop app alongside web and API, or `bun run dev:all` for the raw
Turborepo fan-out. Web-facing modes auto-open the app in your browser;
pass `--no-browser` to skip that.

For production-style cookie-authenticated browser requests (including image
thumbnails), run `STELLA_DEV_SAME_ORIGIN_API=1 bun run agent:up` or
`STELLA_DEV_SAME_ORIGIN_API=1 bun run dev`. The runner sets the app origin,
browser `/api` URL, and Vite proxy target together using this checkout's ports;
server requests still use the API port directly. These computed values override
`.env` and `.env.local` URLs. If a stack is already running, stop it with
`bun run agent:down` before enabling the opt-in.

See the [README](README.md) for the full tech stack and project
structure.

### Typechecking

Run `bun run typecheck` for workspace checks or `bun run typecheck:repo` for
repository tooling. These commands use Bun 1.4.3’s native checker locally and in
CI. For a direct project check, use
`bun check --no-pretty --all --project=<tsconfig path>`; add `--build` for a
solution config with project references. `bun run check:typecheck-parity` compares
TypeScript and Bun diagnostics on repository code and seeded cases.

Editors continue to use the TypeScript language service: Bun provides no LSP.
Keep the TypeScript dependency and its compatibility alias for compiler-API tools
such as dependency-cruiser and for declaration generation.

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
  `@stll/<directory>`.
- Use scoped workspace filters in commands, for example
  `bun --filter @stll/web dev`.
- Scaffold a new package with
  `bun run new-package <name> --description "one line"`: it writes the
  manifest, tsconfig, entry point and README, and registers the knip
  workspace.

## Development Workflow

1. Create a branch from `main` for your changes.
2. Make your changes, following the conventions below.
3. Run checks before pushing:

   ```bash
   bun run autofix
   bun run verify
   ```

   `autofix` regenerates the derived files your change affects, applies
   safe lint fixes and formats the changed files. CI does this on
   same-repository pull requests but not on pull requests from forks, so
   from a fork run it and commit the result.
   `verify` derives cheap pre-push checks from the `STELLA_VERIFY` steps in
   `.github/workflows/ci.yml`: affected lint and typecheck, type-cost,
   ratchets, design backlog, test weights and policy guards. `--fix` runs
   the workflow's safe changed-file fixes first; `--all` checks all packages,
   and `--list` prints the derived plan. Expensive suites remain in CI.

   Hosts with resource admission configure `~/.config/stella/verify.json`:
   Command settings are argument arrays: `localGate` defaults to
   `["load-admit", "--"]`, `remote` to `["remote-check"]`, and `installer`
   to `["serial-install"]`. The gate receives the derived workflow command
   arguments after its configured prefix (`0` admits, `75` refuses, `64`
   reports usage errors). Configure the separator in `localGate`; verification
   adds none. Put executables on `PATH`, or use absolute paths on each host.
   Command arguments cannot contain NUL bytes. On local refusal, the command probes
   remote admission and runs there. Remote fix patches are checked against the
   local tree before applying. If both hosts refuse, it prints that CI will
   validate and exits `75`. The exact-base type-cost fallback uses the configured
   serialized installer. Remote execution still requests local admission and
   uses `REMOTE_CHECK=1` to prevent recursive offload.

4. Open a pull request against `main`.
5. Fill in the PR template and link a related issue.

> In a fresh git worktree run `bun run setup:worktree` once to prepare dependencies.
> `bun run lint:changed` lints only your
> changed files in seconds; CI still runs the full `lint`.

## AI Commands

Stella uses a layered AI command setup:

```text
.ai/shared/              # shared AI repo submodule
.ai/local-skills/        # Stella-specific Codex-style skill source
.claude/skills/          # generated Claude Code skills
.agents/skills/          # generated Codex-style skills
```

Do not hand-edit `.claude/skills/` or `.agents/skills/`;
they are generated from the shared and local sources.

The sync layout is:

```text
.ai/local-skills/<skill>/SKILL.md
.claude/skills/<skill>/SKILL.md
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
  no non-null assertions. See [AGENTS.md](AGENTS.md) for full
  coding conventions.
- **Linting**: Oxlint (Ultracite plus the [custom guards](.oxlint-plugins/README.md))
  for TypeScript; `bun run lint:css` runs Stylelint's correctness checks over
  authored CSS. CSS checks also run in `lint`, `code-check`, and affected CI.
  Tailwind v4 directives and deliberate fallback declarations are supported;
  embedded Astro styles are not scanned. **Formatting**: Oxfmt.
- **Tests**: write tests for new functionality when applicable.

## Changesets

Touching one of these published packages requires a changeset, and CI enforces
it:

<!-- published-packages:start -->
<!-- Rendered from scripts/changeset-policy.json by `bun scripts/check-published-package-lists.ts --write`. Do not edit by hand. -->

- `@stll/agent-input`
- `@stll/ai-catalog`
- `@stll/anonymize-chat`
- `@stll/auth-model`
- `@stll/business-registries`
- `@stll/calculations`
- `@stll/chat`
- `@stll/cli`
- `@stll/conditions`
- `@stll/country-codes`
- `@stll/docx-utils`
- `@stll/mcp-kit`
- `@stll/money`
- `@stll/ssr-kit`
- `@stll/ssr-testkit`
- `@stll/stable-stringify`
- `@stll/start-runtime`
- `@stll/template-conditions`
- `@stll/text-normalize`
- `@stll/time`
- `@stll/ui`
- `@stll/workspace-model`
- `@stll/workspace-ui`

<!-- published-packages:end -->

Add one with:

```sh
bun changeset            # pick the packages and the bump, describe the change
bun changeset --empty    # refactor with no change to the public surface
```

An empty changeset is a deliberate statement, not a way around the check: it
records that the change is internal — a rename behind the export map, a test,
a comment — and produces no version bump. Anything a consumer of the package
can observe needs a real bump.

## Pull Request Checklist

- [ ] Code builds without errors or warnings
- [ ] Changes are tested
- [ ] A changeset is included when a published package changed (empty if the
      public surface did not)
- [ ] CLA is signed by the opener and every commit author, or each is exempt
- [ ] Issue is linked

## Contributor License Agreement

Outside contributors must sign the
[Contributor License Agreement](https://github.com/stella/cla/blob/main/CLA.md)
before their pull request can be merged. Active organization members and owners,
bot accounts, and explicitly allowlisted automation accounts are exempt.

The `cla` check covers the pull request opener and every commit author, and
prompts unsigned contributors automatically. Each contributor must post this
exact sentence as a comment from their own linked GitHub account:

> I have read the CLA Document and I hereby sign the CLA

Signing is a one-time process; existing signatures cover future contributions.
A comment from another account cannot sign for a contributor. Commit authors
without linked GitHub accounts must link their author identity before verification.
Pull requests with more than 250 commits cannot be fully verified by this check.

The CLA grants stella labs, s.r.o. a perpetual license to use your
contributions across all distributions of stella. While the project
ships under Apache-2.0, the CLA preserves clean IP ownership: it lets
us offer commercial arrangements (support, indemnity, custom terms)
alongside the open-source release, and gives the project flexibility
for any future licensing changes. Your contributions remain available
to everyone under Apache-2.0 regardless.

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
