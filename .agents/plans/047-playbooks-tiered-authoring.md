# Plan: Playbooks v2 — tiered authoring, auto-ASK, routing foundation

Date: 2026-07-05. Extends `045-playbooks.md` (slices 1–3 shipped internally).

## Goal

Make playbooks a staple Stella primitive. Two moves:

1. **Authoring speaks the lawyer's language.** A position is authored as a
   tiered ladder — Acceptable / Fallback / Not acceptable — with plain-language
   rules per tier plus ideal language, instead of ASK/EXPECT/GRADE machinery.
   Extraction is derived automatically; manual control moves under Advanced.
2. **Surfaces route into playbooks.** Uploads, document classification, review
   requests, and (later) inbound email attachments resolve applicable playbooks
   through one shared routing point and run them.

Playbooks have never shipped publicly: **no backward compatibility**. The v1
positions shape is replaced outright; one DB migration lifts existing rows;
no runtime v1 read path survives.

## Positions schema v2

Container: `{ version: 2, items: Position[] (max 200) }` — hard
`t.Literal(2)`, no multi-version dispatch.

`Position` becomes a discriminated union on `mode`:

```ts
type Position =
  | {
      mode: "extract";               // captures a value, no grading
      sourceId: Uuid;
      issue: string;                 // 1..256
      ask: AskManual;                // extract-only asks stay explicit
      guidance?: string;             // ≤2000
      enabled: boolean;
    }
  | {
      mode: "graded";
      sourceId: Uuid;
      issue: string;
      severity: "blocker" | "high" | "medium" | "low";
      tiers: {
        acceptable: { rules: TierRule[]; ideal?: IdealLanguage };
        fallback: { entries: FallbackEntry[] };      // ranked by array order, ≤10
        notAcceptable: { rules: TierRule[] };        // red lines
      };
      check?: DeterministicCheck;    // Advanced-only deterministic override
      ask: AskConfig;
      guidance?: string;
      enabled: boolean;
    };

type TierRule = { id: Uuid; text: string };          // 1..500, plain language
type FallbackEntry = { id: Uuid; text: string; label?: string };
type IdealLanguage =
  | { source: "clause"; clauseId: Uuid; clauseVersion?: number }
  | { source: "inline"; text: string };              // ≤10_000

type DeterministicCheck =
  | { kind: "presence"; expectation: "required" | "restricted" }
  | { kind: "constraint"; condition: ConditionNode }; // @stll/conditions AST

type AskManual = { question: string; content: PropertyContent };
type AskConfig =
  | { mode: "auto"; derived?: AskManual & { rulesHash: string } }
  | ({ mode: "manual" } & AskManual);
```

Decisions:

- **Tiers replace `standard`.** Ideal language (clause link or inline text)
  lives inside `acceptable`; v1's ranked fallback *variants* become fallback
  *entries* (they are simultaneously rules and language). `positionMatch` as a
  rule kind disappears — LLM tier-match is the default grading for every
  graded position.
- **`presence`/`propertyConstraint` survive as `check`,** an optional
  deterministic override authored under Advanced. When present, grading is
  deterministic and tiers provide language/fix only. Capability preserved,
  removed from the default authoring path.
- **`enabled` is new** — a disabled position is skipped by run, review, and
  auto-run, and rendered dimmed in the editor.
- **`severity` moves into the graded variant** — it was meaningless on
  extract-only positions.
- **Rules and fallback entries carry `id: Uuid`** (client-generated) so
  reorder/DnD and finding citations reference stable identity, not array
  index. Rank stays implicit in array order.
- Reserved for later slices, not added now: section grouping, playbook
  versioning (JSONB container already carries `version`; definition-level
  versioning is plan-045 slice 4).

## Grading v2 (`apps/api/src/lib/workflow/verdict-engine.ts`)

`gradePositionMatch` → `gradeTierMatch`. The prompt gains all three tiers:

- acceptable rules (numbered), ideal language text (resolved),
- ranked fallback entries,
- not-acceptable (red-line) rules (numbered).

Output (valibot strict):

```ts
{
  tier: "compliant" | "fallback" | "deviation",
  rationale: string,               // ≤1000
  matchedRef?:                     // what decided it
    | { kind: "fallback"; entryId }
    | { kind: "redLine"; ruleId }
}
```

Semantics: `compliant` = satisfies acceptable rules / ideal intent;
`fallback` = matches a fallback entry (cite it); `deviation` = violates a red
line (cite the rule) **or** satisfies nothing. Preserved shortcuts: `missing`
decided pre-LLM when the ASK value is empty; a graded position with zero rules
in all tiers and no ideal language is rejected at validation instead of the
old silent forced-deviation path.

`ResolvedStandard` (resolve-standards.ts) grows into `ResolvedTiers` — the
run-time snapshot embeds resolved ideal text plus tier rules, and
`playbookVerdictToolSchema` (`db/schema-validators.ts`) embeds it, so a run is
graded against what the author saw even if the definition changes mid-run.
`ReviewFinding` gains `matchedRef` (typed like above) so the review facet can
show "violates red line 2" and the compliance-matrix provenance card can show
which fallback matched. `buildFix` semantics unchanged (deviation → replace
cited block, missing → insert after last block, needs resolved ideal text).

## Auto-ASK derivation

For `ask.mode = "auto"`, the server derives `{question, content}` from issue +
tier rules at **save time** (create/update handler): compute `rulesHash`
(stable hash over issue + tier rule texts + check); if the stored `derived`
hash differs, call a small structured-output LLM task
(`feature: "playbook.derive-ask"`) and persist the result on the definition.
Runs and reviews then consume `derived` exactly like a manual ask — run-time
behaviour stays deterministic and inspectable. If derivation fails, save still
succeeds with `derived` absent; run/review fall back to a generic text ask
built from `issue` (never block authoring on an AI call). Positions with
`check: constraint` derive content type from the condition's operand type.

## Mock AI gap (must fix in slice B)

`register-mock-ai.ts`'s `structuredOutput` returns `{}`, which fails any
strict valibot schema — verdict grading and ask-derivation have no working dev
mock. Add schema-aware mock structured output (register per-feature canned
responses for `playbook.verdict` and `playbook.derive-ask`, or generate
minimal valid objects from the valibot schema) so `bun run dev` with
`USE_MOCK_AI=true` exercises the full grade/derive path.

## Editor rebuild (per approved mockup)

`apps/web/src/routes/_protected.knowledge/-components/` rebuild:

- Card = position; header row: drag handle, tabular number, issue title
  (inline edit), severity chip, enable toggle, duplicate, delete, collapse
  chevron. Collapsed header shows per-tier rule counts as colored dots
  (verdict palette: ok/warn/bad semantic tokens).
- Body = tier ladder: Acceptable (rules + ideal language chip/inline),
  Fallback (ranked entries), Not acceptable (rules). Rules are single-line
  plain-language inputs added inline ("+ Rule"), no modals.
- Footer: `Extraction · Auto` chip with the derived question preview under an
  Advanced disclosure; switching to manual exposes question + content-type
  (and select options as proper rows, not newline-textarea). `check` lives
  here too (presence select or condition builder).
- List ergonomics: DnD reorder (reuse an existing in-repo DnD dependency if
  one exists; otherwise keyboard-accessible move + HTML5 drag, no new heavy
  dep without checking), duplicate-position, per-position enable toggle,
  sticky outline rail (hidden < 860px), inline field validation (no
  toast-hunting), extract-only card as the lighter variant.
- coss primitives, semantic tokens, `TranslationKey`-typed keys, existing
  `knowledge.playbooks.*` namespace (keys restructured with the schema).

## Routing foundation

`auto-run.ts`'s `resolveApplicablePlaybooks` is already the routing point
(workspace-wide vs `scope.documentTypeKey` gating against the Document Type
classifier). Slice D formalizes it:

- `scope` gains `trigger`: `"manual" | "onClassified"` (default `manual`).
  `onClassified` playbooks auto-run when the doc-type classifier resolves for
  new documents — find the classification-completion seam in the workflow
  engine and call the existing auto-run path (no polling).
- Export one `routeDocumentsToPlaybooks(...)` helper used by: files-table
  auto-run (today), the classification trigger (new), and any future ingress
  (email intake attachments, chat "review this" → single-doc review). Email
  ingestion itself is out of scope until an email ingress exists in the
  product; the seam takes documents, not emails.
- Folio affordance: when an open document's type matches an applicable
  playbook, the review facet offers it as the preselected suggestion.

## Migration + touchpoints (no compat)

- One hand-authored timestamped migration dir (see `/conventions-db` +
  squawk: statement timeout SET, short names). SQL lifts each stored position:
  `extractOnly` → `mode: "extract"`; graded v1 → `mode: "graded"` with
  `tiers.acceptable.ideal` from inline/clause standard, v1 fallbacks →
  `tiers.fallback.entries`, `presence`/`propertyConstraint` → `check`,
  empty rules arrays elsewhere; `enabled: true` everywhere; ask →
  `{mode:"manual", ...}` (v1 asks were authored). `version` → 2. If a shape
  resists SQL, fall back to `{version:2, items:[]}` for that row — internal
  data only.
- Delete v1-only code: `bundleColumnToPosition` (verify no remaining caller),
  v1 schema variants, old editor facet components.
- Update in lockstep: `playbookVerdictToolSchema` (`schema-validators.ts`),
  MCP `knowledge-tools.ts` redaction `textFields` paths (hardcode
  `positions.items[]` field paths — must match v2: `tiers.acceptable.rules[]
  .text`, `tiers.fallback.entries[].text`, `tiers.notAcceptable.rules[].text`,
  `tiers.acceptable.ideal.text`, `ask.*.question`), `positions-validation.ts`
  (unique sourceId; in-org clause refs now under `tiers.acceptable.ideal`;
  new: graded position must have ≥1 rule in some tier or an ideal, rule ids
  unique), `review-grade.ts` / `materialize-run.ts` / `auto-run.ts` /
  `review.ts` (skip `enabled: false`).
- Frontend types stay Eden-inferred (`playbook-types.ts`) — no manual mirror.

## Slices

- **A — schema v2 + migration + validation** (backend only, engine untouched:
  temporary shim maps v2 → existing grader inputs so the tree stays green).
- **B — grading v2 + auto-ASK + mock coverage** (engine prompt/output,
  resolve-standards → ResolvedTiers, derive-ask task, mock structured output,
  Finding.matchedRef; remove the shim).
- **C — editor rebuild** (parallel with B once A lands).
- **D — routing** (trigger field, classification seam, folio preselection).
- **i18n** — new `knowledge.playbooks.*` keys × 12 locales, small batches,
  baseline update.
- **Verify** — oxfmt, api tests via package script, api typecheck (alone),
  code-review pass per slice; commits per slice on `playbooks-tiered-authoring`.

## Test cases

- Union boundary: graded position with all-empty tiers and no ideal rejected;
  manual ask required on `mode: "extract"`; clause ideal must resolve in-org;
  duplicate rule ids rejected.
- Migration: each v1 rule-kind shape lifts to the documented v2 shape;
  `version` is 2 everywhere after; no v1 reader remains (grep-level check).
- Grading: red-line match → `deviation` with `matchedRef.ruleId`; fallback
  match cites `entryId`; empty ASK still short-circuits to `missing` pre-LLM;
  deterministic `check` bypasses the LLM; disabled positions skipped across
  run/review/auto-run.
- Derivation: rulesHash stability (reorder-insensitive where intended),
  save succeeds when derivation errors, derived ask consumed identically to
  manual by materialize-run and review-extract.
- MCP: redacted field paths cover every v2 free-text location (fixture-based).
- Editor: reorder keeps sourceId identity; duplicate assigns fresh sourceId +
  rule ids; inline validation targets the offending field.

## Non-goals (this wave)

Section grouping, definition versioning, governance/RBAC, AI bootstrap from
corpus, email ingress itself, Word add-in. The v2 shape must not block any of
them (ids everywhere, versioned container, single routing seam).
