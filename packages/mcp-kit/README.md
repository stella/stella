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

Argument reading normalizes supported spellings through `@stll/agent-input`,
rejects missing/unknown parameters, and appends normalization notes to successes.
`exactProperties` bypasses normalization for explicit switches. Handlers own strict
schema validation, including exact switches and cross-field constraints;
`validate_only` checks argument reading without executing the handler and labels
its result with `validation: "argument_reading"`.

## What does not

MCP transport/server wiring, strict JSON Schema validation, authorization,
persistence, or application-specific dispatch. Hosts must enforce these boundaries
and record failures in their own telemetry. No application adopts the kit here.

## License

Apache-2.0
