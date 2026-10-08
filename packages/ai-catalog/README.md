# @stll/ai-catalog

Provider-neutral model roles, provider identifiers, curated model options, and
capability metadata for TypeScript applications.

The package keeps model selection structural: callers choose a logical role,
validate a provider/model pair against one catalogue, and can reject retired or
unsupported selections before a provider request.

```ts
import {
  DEFAULT_MODELS,
  resolveWorkingBYOKModelForRole,
} from "@stll/ai-catalog";

const modelId = resolveWorkingBYOKModelForRole({
  provider: "openai",
  modelId: DEFAULT_MODELS.openai.fast,
  role: "fast",
});
```

The package contains data and validation only. It does not read environment
variables, store credentials, or initialize provider SDKs.

Model rates are committed in `src/model-rates.gen.ts` so application startup
never depends on a pricing service. Rates and capabilities regenerate from
reduced, committed models.dev and OpenRouter inputs in `upstream/`:

```sh
bun --filter @stll/ai-catalog gen:rates --from-snapshot
bun --filter @stll/ai-catalog gen:capabilities --from-snapshot
```

`--check` verifies these outputs offline, with network fetches blocked.
To refresh both inputs and outputs from upstream, run `gen:rates --refresh`,
then `gen:capabilities --from-snapshot`. The scheduled catalog check maintains
one refresh pull request for both snapshots.
`gen:capabilities --refresh` rejects before fetching or writing: rates owns the
shared upstream refresh, and capabilities reads those refreshed inputs.
The snapshot covers text input/output, cache reads/writes, and context tiers.
Audio pricing is deliberately excluded because Stella does not route audio
model input; an unknown models.dev cost field fails generation.

## Install

```sh
bun add @stll/ai-catalog
```

## License

Apache-2.0
