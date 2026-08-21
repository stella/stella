# @stll/anonymize-chat

Shared contracts for reversible, placeholder-safe anonymization of text before
it crosses a third-party boundary.

The package configures `@stll/anonymize-wasm`, preserves literal placeholder
tokens, supports caller-supplied exact sensitive values, and returns one
placeholder-to-original map for controlled restoration.

```ts
import { runChatAnonPipeline } from "@stll/anonymize-chat";

const result = await runChatAnonPipeline({
  runtime,
  dictionaries,
  text,
  workspaceId,
  forcedSensitiveValues: [internalReference],
});
```

Runtime bindings and dictionaries are dependency-injected so browser workers,
servers, and tests can own their loading strategy.

## Install

```sh
bun add @stll/anonymize-chat @stll/anonymize-wasm
```

## License

Apache-2.0
