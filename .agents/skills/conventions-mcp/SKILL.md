---
name: conventions-mcp
description: Apply when adding or changing an MCP tool, a capability the CLI generates, a tool input or output schema, a tool description, an error envelope, or an agent-facing reference resource. Enforces contracts that language models can actually drive, measured by evals rather than by schema soundness.
---

# Agent-Facing Contract Conventions

An MCP tool or CLI capability is a user interface whose user is a language model.
A schema can be type-sound, validated, and documented and still be undrivable:
models copy examples, fill every property they see, retry with the same call,
and cannot inspect bytes. Design for that behaviour and measure it.

## Target Property

A capable model, given only what `tools/list` and the reference resources expose,
completes the workflow on the first or second attempt, and every rejection it
receives names the next call to make. The authoring eval, not code review, decides
whether a contract change helped.

## Measure Before Believing

1. **An eval is the acceptance test.** Every agent-facing workflow has an eval that
   drives the real tools with the real schemas and scores each step separately
   (authored, created, configured, filled, or the workflow's equivalents). Run it
   before and after a contract change and put both tables in the PR. A change that
   is "obviously better" without numbers is a hypothesis.
2. **Keep the rejected call, in the eval only.** The eval records the raw input
   of every call the schema rejected before the handler ran; a pass rate without
   the rejected payloads cannot say whether the model or the contract failed.
   Eval fixtures are synthetic, so the trace may hold them whole. Production
   telemetry for a rejected call records the tool name, the issue codes, and the
   issue paths, never the payload: tool arguments carry matter content and
   personal data.
3. **Parse through the schema the handler uses.** The eval, the tests, and the
   handler must validate the same object; a normalisation that lives only in one
   handler's pre-step is invisible to the eval and drifts.

## Shape Tools For How Models Behave

4. **One tool, one intent.** Split create, configure, and update into separate
   tools rather than one tool whose meaning depends on which optional arguments
   are present. Cross-field "provide A or B, not both" checks are a sign the tool
   has more than one job.
5. **Few optionals, one discriminator.** Replace a set of mutually exclusive
   optional keys with one discriminated union (`source: { type: "ai" | "lookup"
   | ... }`). A model that fills every property cannot produce a contradictory
   union member; it can produce six contradictory optionals.
6. **Best effort over all-or-nothing for collections.** When a call carries a
   list of entries, validate each entry independently, apply the valid ones, and
   return the rest as per-entry `issues[]`. One bad property must not sink a call
   that carried seven good entries.
7. **Echo the next call.** Return, from the call that discovers state, the exact
   payload the next call accepts (a `configure` skeleton, canonical path spelling,
   allowed values). Copying beats inferring. Read-back must round-trip: the shape
   a describe tool returns is the shape the configure tool accepts, byte for byte,
   and a test pins that fixed point.
8. **Idempotent and re-entrant.** Models retry with the same call and resend
   everything they know. Accept the resend: upsert on a stable id, idempotency
   keys that cover every argument, durable receipts replayed without re-executing.
9. **Keep artefacts out of the model.** Bytes are the hardest step in any loop.
   Prefer references (a host file reference, an id of something already stored)
   over inline base64; when inline is the only path, bound it by the request
   frame, derive the limit from the shared constant, and state it in the
   description. Never let an error hint invite the model to shrink or rewrite a
   document.

## Every Error Is A Next Step

10. **Structured envelope, closed codes.** Failures return `{ code, message, hint,
    issues[] }` with codes from a closed set. `hint` names the corrective action,
    the tool to call, and where to go (a deep link when the fix is in the UI).
    "Disabled" without "enable it here" is a dead end.
11. **Never leak the substrate.** A malformed id is a validation issue at the
    boundary, never a database cast error reported as `internal_error`. Every id
    input is declared with the shared id schema; a registry-wide test enforces it.
12. **Warn about what the model probably meant.** Discovery and save return
    `warnings[]` with closed codes for the known traps (unprefixed loop item,
    unknown directive, split marker, and so on). A census test keeps the code
    list and the reference in step.
13. **Read each value kind leniently, in one place.** A model spells a value the
    way its training data did: `null` for an unset optional, `4 000` for a
    number, `1. 10. 2026` for a date, `ano` for a boolean, `cs_CZ` for a locale.
    Every kind the wire accepts gets ONE owner that auto-normalizes the
    spellings carrying a single meaning and returns ONE ask-for-a-fix shape
    (`received`, `expected`, `hint`) when a spelling carries two: `01/02/2026`
    and a bare `1,234` are asked about with both readings named, never guessed,
    because guessing wrong is a wrong date or a factor of a thousand on an
    instrument. Null and the placeholder encodings are that rule for "absent"
    and live in the tool factory; the value kinds live in
    `apps/api/src/lib/agent-input/`. Cover each kind with a property test over
    its whole spelling class rather than the examples someone happened to
    write down, and add a guard (an ownership row, a census test) so a new call
    site cannot parse the kind itself. Never per-tool tolerance code, and never
    a second reader: two lenient readers of one kind are worse than one strict
    one, because they disagree.

## References Are Read Verbatim

14. **Every sentence must be true of the code.** Reference resources and tool
    descriptions are copied into model context as the complete contract. A
    promised behaviour the code does not have (a preserved extension, a size limit
    that is not the enforced one) is a bug, not a docs nit. Render numbers from the
    constants; type tool names against the registry; keep drift tests.
15. **One workflow resource per workflow.** Publish the ordered steps (create,
    read back, configure, preview, persist) as a resource pointed to from the MCP
    instructions, and keep the quiz or eval that checks a model understood it.
16. **Decide grammar leniency by evidence.** When two independent models write the
    same form the grammar rejects, that is a product signal: either accept the
    form or make the reference unambiguous, then re-measure. Do not do both at
    once.

## Guards Make It Stick

- Registry-wide tests over every tool definition: id schemas, null-optional
  tolerance, description and reference drift, and a zero-diff capability export.
- Total companion maps keyed by tool name (`as const satisfies Record<ToolName,
  ...>`) for policy, consent, projection, and CLI disposition, so a new tool cannot
  land without each decision.
- Compile-time gates in the tool factory (a schema that is not wrapped, an id that
  is not the shared schema) rather than review discipline.
- The CLI is generated from the same catalog: a capability whose transport the
  generator cannot invoke is not advertised anywhere, and generated artifacts are
  regenerated in order (capability export, then CLI codegen) until the diff is
  zero.

## Existing References

- Tool factory and boundary normalisation: `apps/api/src/mcp/valibot-tool-definition.ts`,
  `apps/api/src/mcp/tool-utils.ts`
- One reader per value kind, and its census: `apps/api/src/lib/agent-input/`,
  `apps/api/src/lib/agent-input/agent-input-owner.test.ts`
- Registry-wide guards: `apps/api/src/mcp/uuid-id-inputs.test.ts`,
  `apps/api/src/mcp/null-optional-inputs.test.ts`
- Warnings census and references: `apps/api/src/lib/docx/template-warnings.ts`,
  `apps/api/src/mcp/template-workflow-reference.ts`
- Authoring eval: `apps/api/evals/template-authoring.ts`

These are examples of the mechanisms, not proof that a new tool meets the bar:
run the eval.
