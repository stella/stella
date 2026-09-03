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
never depends on a pricing service. Regenerate the snapshot from
[models.dev](https://models.dev) with `bun --filter @stll/ai-catalog gen:rates`;
rate-related pull requests verify the committed output against that source.
The snapshot covers text input/output, cache reads/writes, and context tiers.
Audio pricing is deliberately excluded because Stella does not route audio
model input; an unknown models.dev cost field fails generation.

## Install

```sh
bun add @stll/ai-catalog
```

## License

Apache-2.0
