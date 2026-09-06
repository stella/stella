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

## Native image support

HEIC/HEIF support is derived only from committed provider/model/MIME probe
evidence in `src/native-image-probes.json`. Unprobed, rejected, and inconclusive
tuples are disabled. A newer probe replaces the previous result, including an
inconclusive result; no provider or model family inherits another tuple’s support.

Import real probe reports with
`bun --filter @stll/ai-catalog gen:native-image-support -- /path/to/report.json`.
Multiple report paths are accepted. The importer validates the versioned schema,
rejects duplicate, stale, and conflicting records, and sorts the snapshot
deterministically. Run `gen:native-image-support -- --check` to validate the
committed snapshot. With report paths, `gen:native-image-support -- --check /path/to/report.json`
fails only when effective support changes; newer timestamps and provenance alone
do not fail CI. Both modes validate the schema and reject stale or conflicting
evidence without writing. Review and commit imported evidence before deployment.

Native image probes are standalone checks, excluded from the scheduled provider
canary. Recorded results remain in use until deliberately replaced, with no
recurring provider calls. Run a focused local probe when adding a model or
investigating a relevant provider or adapter change:
`bun --cwd apps/api canary:native-image -- --provider google --model gemini-3.7-flash --output /tmp/native-image-google.json`
using `AI_CANARY_API_KEY`. Omit `--model` for the provider catalog sweep. Reports
contain only synthetic-fixture results and provenance. Adapter upgrades retain
recorded support until fresh probes are imported; they do not inherit evidence
for newly added model IDs.

## Install

```sh
bun add @stll/ai-catalog
```

## License

Apache-2.0
