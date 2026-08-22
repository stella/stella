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

## Install

```sh
bun add @stll/ai-catalog
```

## License

Apache-2.0
