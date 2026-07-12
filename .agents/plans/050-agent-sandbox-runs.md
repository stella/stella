# 050 — Agent Sandbox Runs (local + cloud execution engine)

## Summary

Give stella chat threads a real computer to work in: a sandboxed filesystem +
shell + workspace where a coding-agent harness (Claude Code, Codex, OpenCode)
executes, streaming its work back into the existing chat thread. Two execution
locations behind one abstraction:

- **Local** — the harness runs on the user's own machine via the desktop app,
  authenticated with the user's own subscription/login. Their spend, their
  machine.
- **Cloud** — the harness runs in a gVisor-isolated Docker sandbox on stella's
  own AWS (eu-central-1), metered against the credits system.

Both are configurations of the same `@tanstack/ai-sandbox` middleware on the
same `chat()` call stella already runs (`apps/api/src/handlers/chat/stream-chat.ts`),
so a run streams the same AG-UI chunks into the same thread UI regardless of
where it executed.

This plan delivers the **cloud tier end to end** and the **local tier's bridge
contract**, leaving the desktop UI wiring and the Anthropic Agent SDK approval
as tracked follow-ups.

## Why (context, not re-litigated here)

Decision trail lives in memory: `project_local_engine_subscription_routing`,
`project_subscription_oauth_byok_posture`, `public-tools-catalogue`. Short
version:

- The SKILL.md ecosystem stella's `/tools` catalogue consumes ships executable
  scripts; stella currently can only read them, not run them. Every horizontal
  platform executes them; no legal product does. This closes that gap.
- Subscription auth is only sanctioned when the vendor's own binary holds the
  credential (local, tolerated) or via an approved Agent SDK app; running a
  user's subscription from stella's servers is banned and enforced. So cloud
  execution uses API keys / credits only, never subscription auth.

## Non-goals

- No subscription auth in stella's cloud (banned zone).
- No persistent "cloud PC" per user — sandboxes are ephemeral per run,
  seeded from an image snapshot; matter state stays in the API/DB, never
  accumulates on a VM.
- Not porting background/async AI (ingestion, embeddings, scheduled workflows)
  onto this engine — those stay server-side on credits/BYOK.
- Desktop app UI for the local tier is a follow-up; this plan defines the
  bridge endpoint contract it will call.

## Architecture

### The three moving parts (TanStack AI sandbox model)

`defineSandbox({ provider, workspace, policy, lifecycle })` + `withSandbox()`
middleware on `chat()`. We fix:

- **Provider**: `dockerSandbox` is canonical (self-hostable, own-infra,
  terraform-able). Local tier uses `localProcessSandbox` under the desktop app.
- **Workspace**: NOT a git repo clone (the TanStack examples are coding-on-repos
  shaped). Our workspace is a scratch dir seeded with the skill package (from
  the `/tools` catalogue install payload or pinned github fetch) plus an
  `AGENTS.md` describing available stella MCP tools. Secrets: a short-lived,
  workspace-scoped stella session token — NOT a raw org API key.
- **Harness adapter**: `codexText` first (sanctioned integration surface),
  `claudeCodeText` behind the Agent SDK approval, `opencodeText`/`acpCompatible`
  opportunistically.
- **Policy**: allow/ask/deny. Deny raw network egress by default; the only
  outbound path is the egress proxy allowlist (stella MCP + explicitly allowed
  hosts).

### Tool unification (the key design)

The in-sandbox agent reaches stella workspace capabilities ONLY through the
stella MCP server (`project_stella_mcp_design`), never direct DB/S3. TanStack's
host-tool bridging exposes the same tool surface into the sandbox. So
permissions, audit events, and tenant isolation are enforced server-side in one
place regardless of which harness/brain drives. This is what prevents a
"two brains, two tool surfaces" maintenance split.

### Engine selection (per run, pinned at creation)

`engine: "local" | "cloud"`, `harness: "codex" | "claude-code" | ...` chosen
when the run starts, immutable for that run. Selection policy:

- Desktop bridge reports an installed+authed harness → offer `local`.
- Otherwise / desktop offline / org policy requires it → `cloud`.
- Org/team workspaces default `cloud` on org BYOK or credits; `local` is
  org-admin-enabled (consumer-subscription data-governance is the admin's
  call). Solo workspaces default `local` when a harness is detected.

### Cloud isolation (stella's job, not the framework's)

- **gVisor (runsc)** runtime on the sandbox hosts — syscall isolation for
  agent-run code sitting near secrets.
- **Egress proxy allowlist** — Claude-Code-web model; sandbox reaches only the
  MCP endpoint + explicit allowlist.
- **Secrets outside the sandbox** — Codex two-phase model: seed the workspace,
  then run the agent phase with only the scoped MCP token in-env, never the org
  API key.
- **Ephemeral lifecycle** — `reuse: "thread"`, `keepAlive` short, destroy on
  finish; snapshot only the base image, never run state.

## Metering & pricing

Cloud runs burn credits (VM-minutes + tokens) via the existing metering system
(`project_ai_metering_byok`, `project_usage_entitlements`). Local runs burn
nothing (user's own subscription). This completes the spend ladder: credits
(default) → org BYOK key → connected CLI (local) → cloud runner. Frame in UI as
"AI spend sources" with per-feature routing, not credentials.

## Implementation phases

### Phase 1 — Engine abstraction + cloud path (this plan's core)

1. New package `@stll/agent-engine` (`packages/agent-engine`): wraps
   `@tanstack/ai-sandbox` + adapters, exposes `defineStellaSandbox({ engine,
   harness, workspaceSpec, mcpToken })`. Pin all `@tanstack/ai-sandbox*` and
   adapter versions exactly (0.2.x, ~2 weeks old, API churn risk).
2. Wire `withSandbox()` into `stream-chat.ts` at the `chat({...})` call
   (line ~711) behind a new run-mode discriminator; when engine is unset the
   path is byte-identical to today (no behavior change for normal chat).
3. `dockerSandbox` provider config: base image (Bun + Node + the harness CLIs),
   gVisor runtime, workspace seeding from a skill package, egress-proxy env.
4. Scoped MCP token: mint a short-lived workspace-scoped token for the sandbox;
   the in-sandbox `AGENTS.md`/MCP config points at the stella MCP endpoint via
   the proxy. Never inject the org API key.
5. Metering hook: emit VM-minutes + token usage as credit consumption on run
   finish; reuse the chat usage recording path.
6. Persistence caveat: sandbox module ships in-memory resume stores only;
   accept ephemeral-only resume for v1 (a run that outlives an API restart is
   lost) and note the follow-up.

### Phase 2 — Local bridge contract

1. Extend the desktop bridge (`apps/desktop/src-tauri/src/bridge.rs`) with a
   `/v1/agent-run` surface mirroring the existing `/v1/open-docx` posture
   (origin allowlist incl. prod web origin, PNA headers, session-token
   validation).
2. Harness detection endpoint: desktop reports which harnesses are installed +
   authed (probe `codex`/`claude` on PATH); web onboarding only sets an
   "asked" flag, detection is desktop-side.
3. Per-run desktop-side consent prompt (skill slug + pinned SHA + which harness
   + what it will do) — a web click alone must NEVER start execution
   (zero-click lesson from PR #1030). Post an audit event back to the API per
   run.
4. Local run streams AG-UI chunks up to the API so the webapp thread matches a
   cloud/server thread.

### Phase 3 — Infra (stella-infra, separate repo/PR)

1. Terraform: EC2 sandbox host pool in eu-central-1 (ECS EC2 launch type or
   raw ASG — NOT Fargate, needs Docker socket), autoscaled; gVisor installed
   via launch template/AMI.
2. Egress proxy (allowlist) in front of the pool.
3. Follows the deploy ordering rule (`feedback_cross_repo_deploy_ordering`):
   stella-infra main → both envs; app flag gates exposure.

### Phase 4 — Follow-ups (tracked, not in this plan)

- Anthropic Agent SDK approval application (long lead time — START EARLY in
  parallel; gates the `claude-code` cloud harness with subscription-limit
  draw). Codex ships without it.
- Desktop app UI for the local tier.
- Durable sandbox resume (await TanStack persistence package or bring our own
  `SandboxStore`).
- Re-add script-heavy catalogue seeds (legal-diagram etc.) once execution
  exists + content-hash dedupe lands.

## Flags & rollout

- `AGENT_SANDBOX_RUNS_ENABLED` (server) gates the whole engine path; off = chat
  unchanged.
- Cloud tier defaults off until Phase 3 infra is live.
- Local tier defaults off until the desktop bridge + consent (Phase 2) ship.

## Risks

- **TanStack sandbox API churn** (0.2.x, ~2wk old): pin exact versions, isolate
  behind `@stll/agent-engine` so a breaking bump is one package's problem.
- **Isolation is stella's responsibility**, not the framework's: gVisor +
  egress proxy + secrets-outside-sandbox are non-negotiable before cloud tier
  is exposed to tenant data.
- **Provider lock-in**: mitigated — provider is one field; Docker canonical
  keeps self-hosting first-class; Daytona is the managed fallback only if the
  host-pool ops burden proves too heavy (verify EU region + DPA first).
- **Anthropic approval latency**: Codex-first sequencing means the architecture
  ships and proves out without waiting on it.

## Verification

- Phase 1: an integration test drives `chat()` with `withSandbox` against a
  local Docker daemon, asserts the agent's edits/commands stream back as chunks
  and a skill script actually executes; the no-engine path is asserted
  unchanged.
- Security: egress-deny test (sandbox cannot reach a non-allowlisted host);
  secret-absence test (org API key never present in the sandbox env).
- Metering: a cloud run records credit consumption; a local run records none.
