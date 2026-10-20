# @stll/mcp-kit

Framework-free MCP tool registry, compact schemas, and lazy capability discovery.

## What lives here

A transport-neutral registry with direct tools and three discovery tools:
`list_capabilities`, `describe_capability`, and `invoke_capability`. Handlers return
JSON text or `{ error: { code, message, hint, retryable } }` with optional issues.
Runtime dependencies are `@stll/agent-input` for normalization and `better-result`
for invariant and failure handling.

```ts
import { createToolSurface, success } from "@stll/mcp-kit";

const surface = createToolSurface({
  tools: [
    {
      name: "items.list",
      summary: "List items.",
      access: "read",
      domain: "items",
      inputSchema: { type: "object", properties: {} },
      run: async () => success({ items: [] }),
    },
  ],
});

surface.listTools();
await surface.callTool("describe_capability", { capability: "items.list" }, {});
await surface.callTool(
  "invoke_capability",
  { capability: "items.list", input: {} },
  {},
);
```

`describe_capability` defaults to a compact description under 3 KB of UTF-8 JSON:
summary, parameter names/types/required flags/enums, and one invocation example.
Set `exampleInput` on the definition to supply representative arguments; otherwise
the example is an empty invocation skeleton. Examples exceeding the budget also
fall back to the skeleton.
Nested schemas and long guidance stay out of that response. Parameters that exceed
the budget are counted in `omittedParameters`; request
`{ capability: "items.list", detail: "full" }` for the complete `inputSchema` and
guidance. The skeleton's empty `input` must be filled using the parameter outline
or full schema before invoking tools with required arguments. Names must be nonempty and fit in
128 UTF-8 bytes so compact descriptions remain bounded.

Only tools with a `direct` schema appear individually in `listTools()`; the other
tools are paged through `list_capabilities` with domain/access filters and opaque
portable base64url cursors. Discovery descriptions do not grow with the registry.
`compactSchema` strips annotations while preserving validation keywords and
`hoistRepeatedSchemas` shares repeated shapes through `$defs`.

Input schemas declare argument names directly in an object root. Root references,
composition, conditional or dynamic property declarations, and open
`additionalProperties` are rejected at registry construction. Nested schema
composition and references remain available for normalization and handler validation.

Argument reading normalizes supported spellings through `@stll/agent-input`,
rejects missing/unknown parameters, and appends normalization notes to successes.
`exactProperties` bypasses normalization for explicit switches. Handlers own strict
schema validation, including exact switches and cross-field constraints;
`validate_only` checks argument reading without executing the handler and labels
its result with `status: "arguments_read"`; it makes no full-schema validity claim.

Schema and example metadata must contain acyclic JSON data; invalid definitions
are rejected during registry construction. Successful handler payloads use the `McpJsonValue` type. Serialization failures and
rejected handlers return a generic `internal_error`; `onError(cause, event)` can
record the original cause in host telemetry. The observer runs synchronously;
its own failures cannot expose exception messages on the wire.

## Downstream discovery options

The default wire format stays unchanged. Downstream CLIs can select an outline
format with short guidance and bare examples, a described full schema, and
unwrapped capability results:

```ts
const surface = createToolSurface({
  tools,
  discovery: { type: "outline" },
  fullSchema: "described",
  capabilityResult: "payload",
  validationResult: "input",
  capabilityList: "minimal",
  metaDescriptions: "enumerated",
});
```

`brief` is appended to the summary in both discovery formats; bounded discovery
retains its size limits, while outline discovery preserves the complete brief.
`guide` remains full-only.
Parameters are a name-to-type map with required markers, and `exampleInput`, when
present, is returned as bare `example` arguments. Outline discovery has no byte
budget. Full descriptions omit `domain` in this format; `fullSchema: "described"`
selects `describedSchema ?? inputSchema` without changing invocation validation.
`capabilityResult: "payload"` returns successful handler payloads directly.
`validationResult: "input"` returns `{ valid: true, input }` with normalized
arguments; this checks argument reading, not full-schema validity.
`capabilityList: "minimal"` omits `limit`, item `description`, and false
`destructive` fields. `metaDescriptions: "enumerated"` lists lazy tool names in
the discovery tool description. Each option is independent.

Use `compactSchema(schema, { omitMaxSafeInteger: true, schemaDialect: "omit" })`
to omit safe-integer maximum bounds and dialect declarations in advertised
schemas. These transformations only visit schema positions; enum, const and
extension data remain intact. Prepare `direct.inputSchema` and `describedSchema`
only when the host separately enforces the omitted ceiling and the transport
already fixes the dialect. A safe-integer maximum is a real validation constraint;
JSON Schema integer alone does not imply it. Preserve bounds and dialects in
validation schemas and full discovery. A `describedSchema` selected for full
discovery must preserve canonical validation constraints; the kit does not prove
equivalence. Hoisting still preserves reference scopes and existing definitions.
`hoistRepeatedSchemas(schema, { definitionNames: "property" })` names repeated
union and item branches after their nearest property; the default uses the schema
keyword. This changes definition and reference names without changing traversal
or reference-scope safeguards.

Published artifacts contain the bundled module and declarations; source contract
tests run in this repository.

## What does not

MCP transport/server wiring, strict JSON Schema validation, authorization,
persistence, or application-specific dispatch. Hosts must enforce these boundaries
and record failures in their own telemetry. No application adopts the kit here.

## License

Apache-2.0
