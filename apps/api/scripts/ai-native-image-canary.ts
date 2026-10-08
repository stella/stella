// Standalone probe: does a provider/model read a HEIC/HEIF image sent as the
// original bytes? Excluded from the scheduled provider canary; run it by hand
// when evaluating a model or an adapter change:
//
//   AI_CANARY_API_KEY=... bun --cwd apps/api canary:native-image -- \
//     --provider google [--model <id>] --output /tmp/native-image.json
//
// The fixture `fixtures/native-image-canary.heic` is an 800 x 300 synthetic
// image of the token below, black on white, with no other content. The same
// HEIF container is sent under both MIME types without conversion, and the
// token never appears in the prompt or schema, so an HTTP success alone never
// counts as support. Reports carry the fixture hash, adapter version, Git
// revision and runner hash; changing what the probe means needs a new
// `probeVersion`.

import type { ModelMessage } from "@tanstack/ai";
import { Result, TaggedError } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { isBYOKModelRoleSupported } from "@stll/ai-catalog";

import { NO_ORGANIZATION_MODEL_DISPATCH } from "@/api/lib/rate-limit/model-dispatch-admission";
import {
  generateTanStackObjectForRole,
  resolveTanStackTextModel,
} from "@/api/lib/tanstack-ai-generate";

import {
  catalogModelIds,
  classifyCanaryFailure,
  createCanaryConfig,
  runCanaryProbe,
} from "./ai-provider-canary";
import {
  CANARY_PROVIDERS,
  modelRoleMaxOutputTokens,
} from "./ai-provider-canary-config";
import type { CanaryProvider } from "./ai-provider-canary-config";

const FIXTURE = new URL("fixtures/native-image-canary.heic", import.meta.url);
const EXPECTED_TOKEN = "K7M4P9";
const PROBE_TIMEOUT_MS = 45_000;
const SWEEP_TIMEOUT_MS = 10 * 60 * 1000;
const MIME_TYPES = ["image/heic", "image/heif"] as const;
const ADAPTER_PACKAGES = {
  google: "@tanstack/ai-gemini",
  openrouter: "@tanstack/ai-openrouter",
  openai: "@tanstack/ai-openai",
  anthropic: "@tanstack/ai-anthropic",
  bedrock: "@tanstack/ai-bedrock",
  mistral: "@tanstack/ai-mistral",
} as const satisfies Record<CanaryProvider, string>;

type HeicMimeType = (typeof MIME_TYPES)[number];

const canonicalTimestamp = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Invalid canonical UTC timestamp",
  ),
);

const nativeImageProbeRecordSchema = v.strictObject({
  provider: v.picklist(CANARY_PROVIDERS),
  modelId: v.pipe(v.string(), v.minLength(1)),
  mimeType: v.picklist(MIME_TYPES),
  status: v.picklist(["supported", "unsupported", "inconclusive"]),
  checkedAt: canonicalTimestamp,
  fixtureSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  adapterVersion: v.pipe(v.string(), v.minLength(1)),
  sourceRevision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}:[a-f0-9]{64}$/u)),
});

export type NativeImageProbeRecord = v.InferOutput<
  typeof nativeImageProbeRecordSchema
>;

export const nativeImageProbeReportSchema = v.strictObject({
  probeVersion: v.literal(1),
  records: v.array(nativeImageProbeRecordSchema),
});

class NativeImageCanaryError extends TaggedError("NativeImageCanaryError")<{
  message: string;
}> {}

// HTTP 400 can mean schema or model errors. Only an explicit image-format
// rejection is evidence of unsupported input; outages remain inconclusive.
type NativeImageFailureKind = "operational" | "format-rejected" | "unknown";

const nativeImageFailureKind = (
  error: unknown,
  depth = 0,
): NativeImageFailureKind => {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return "unknown";
  }
  if (classifyCanaryFailure(error).kind === "credential-rejected") {
    return "operational";
  }
  for (const key of ["status", "statusCode", "code"]) {
    if (key in error) {
      const value: unknown = Reflect.get(error, key);
      // Adapters relay an SDK status as `code: String(err.status)`.
      const status =
        typeof value === "string" && /^\d{3}$/u.test(value)
          ? Number(value)
          : value;
      if (
        typeof status === "number" &&
        (status === 401 || status === 403 || status === 429 || status >= 500)
      ) {
        return "operational";
      }
    }
  }
  let kind: NativeImageFailureKind = "unknown";
  for (const key of ["cause", "error"]) {
    if (!(key in error)) {
      continue;
    }
    const nested = nativeImageFailureKind(Reflect.get(error, key), depth + 1);
    if (nested === "operational") {
      return nested;
    }
    if (nested === "format-rejected") {
      kind = nested;
    }
  }
  if ("message" in error && typeof error.message === "string") {
    const message = error.message.toLowerCase();
    if (/(?:status[ :]+429|rate.limit|resource_exhausted)/u.test(message)) {
      return "operational";
    }
    if (
      /(?:heic|heif|mime|media_type|image format|image type)/u.test(message) &&
      /(?:not support|unsupported|not allowed|input should be|must be one of|supported formats|supported mime)/u.test(
        message,
      )
    ) {
      return "format-rejected";
    }
  }
  return kind;
};

export const isNativeImageFormatRejection = (error: unknown): boolean =>
  nativeImageFailureKind(error) === "format-rejected";

const nativeImageMessages = (
  bytes: Uint8Array,
  mimeType: HeicMimeType,
): ModelMessage[] => [
  {
    role: "user",
    content: [
      {
        type: "image",
        source: {
          type: "data",
          value: Buffer.from(bytes).toString("base64"),
          mimeType,
        },
      },
      {
        type: "text",
        content:
          "Read the single alphanumeric identifier printed in the image. Return it verbatim as token. Do not guess if the image cannot be read.",
      },
    ],
  },
];

type ProbeNativeImageOptions = {
  apiKey: string;
  provider: CanaryProvider;
  modelId: string;
  mimeType: HeicMimeType;
  bytes: Uint8Array;
  signal: AbortSignal;
};

export const probeNativeImage = async ({
  apiKey,
  provider,
  modelId,
  mimeType,
  bytes,
  signal,
}: ProbeNativeImageOptions): Promise<void> => {
  const orgAIConfig = createCanaryConfig({
    apiKey,
    provider,
    rotatedModelId: modelId,
  });
  const model = await resolveTanStackTextModel({
    dataClass: "public_corpus",
    role: "chat",
    orgAIConfig,
    organizationId: null,
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
  });
  if (model.provider !== provider || model.modelId !== modelId) {
    throw new NativeImageCanaryError({
      message: "Native image probe resolved a different model",
    });
  }
  const output = await generateTanStackObjectForRole({
    dataClass: "public_corpus",
    role: "chat",
    orgAIConfig,
    organizationId: null,
    admission: NO_ORGANIZATION_MODEL_DISPATCH,
    tenantWorkspaceIds: [],
    serviceTier: "standard",
    caching: { enabled: false, reason: "org-disabled" },
    abortSignal: signal,
    maxOutputTokens: modelRoleMaxOutputTokens({ modelId, role: "chat" }),
    messages: nativeImageMessages(bytes, mimeType),
    outputSchema: v.strictObject({ token: v.string() }),
  });
  if (output.token.trim() !== EXPECTED_TOKEN) {
    throw new NativeImageCanaryError({
      message: "Native image probe did not read the image",
    });
  }
};

type RunNativeImageProbesOptions = {
  apiKey: string;
  provider: CanaryProvider;
  modelIds: readonly string[];
  bytes: Uint8Array;
  adapterVersion: string;
  sourceRevision: string;
  probe?: typeof probeNativeImage;
  runProbe?: typeof runCanaryProbe;
  now?: () => number;
};

export const runNativeImageProbes = async ({
  apiKey,
  provider,
  modelIds,
  bytes,
  adapterVersion,
  sourceRevision,
  probe = probeNativeImage,
  runProbe = runCanaryProbe,
  now = Date.now,
}: RunNativeImageProbesOptions): Promise<NativeImageProbeRecord[]> => {
  const records: NativeImageProbeRecord[] = [];
  const fixtureSha256 = new Bun.CryptoHasher("sha256")
    .update(bytes)
    .digest("hex");
  const deadline = now() + SWEEP_TIMEOUT_MS;
  for (const modelId of modelIds) {
    for (const mimeType of MIME_TYPES) {
      const remaining = deadline - now();
      const result =
        remaining > 0
          ? await runProbe({
              timeoutMs: Math.min(PROBE_TIMEOUT_MS, remaining),
              run: async (signal) =>
                await probe({
                  apiKey,
                  provider,
                  modelId,
                  mimeType,
                  bytes,
                  signal,
                }),
            })
          : null;
      let status: NativeImageProbeRecord["status"] = "inconclusive";
      if (result?.status === "passed") {
        status = "supported";
      } else if (
        result?.status === "failed" &&
        !result.signal.aborted &&
        isNativeImageFormatRejection(result.error)
      ) {
        status = "unsupported";
      }
      records.push({
        provider,
        modelId,
        mimeType,
        status,
        checkedAt: new Date(now()).toISOString(),
        fixtureSha256,
        adapterVersion,
        sourceRevision,
      });
      console.log(
        `[native-image-canary] ${provider}/${modelId}/${mimeType}: ${status}`,
      );
    }
  }
  return records;
};

const run = async () => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      output: { type: "string" },
    },
    strict: true,
  });
  const provider = v.parse(v.picklist(CANARY_PROVIDERS), values.provider);
  const output = v.parse(v.pipe(v.string(), v.nonEmpty()), values.output);
  const apiKey = process.env["AI_CANARY_API_KEY"];
  if (!apiKey) {
    throw new NativeImageCanaryError({
      message: "AI_CANARY_API_KEY is required",
    });
  }
  const modelIds = catalogModelIds(provider).filter((modelId) =>
    isBYOKModelRoleSupported({ provider, modelId, role: "chat" }),
  );
  if (values.model !== undefined && !modelIds.includes(values.model)) {
    throw new NativeImageCanaryError({
      message: "Requested model is not in the provider catalog",
    });
  }
  const adapterPackage = ADAPTER_PACKAGES[provider];
  const packageJson: unknown = await Bun.file(
    Bun.resolveSync(`${adapterPackage}/package.json`, import.meta.dir),
  ).json();
  const { version } = v.parse(v.object({ version: v.string() }), packageJson);
  const revision = await Bun.$`git rev-parse HEAD`.text();
  const sourceHash = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(import.meta.path).bytes())
    .digest("hex");
  const records = await runNativeImageProbes({
    apiKey,
    provider,
    modelIds: values.model === undefined ? modelIds : [values.model],
    bytes: await Bun.file(FIXTURE).bytes(),
    adapterVersion: `${adapterPackage}@${version}`,
    sourceRevision: `${revision.trim()}:${sourceHash}`,
  });
  const report = v.parse(nativeImageProbeReportSchema, {
    probeVersion: 1,
    records,
  });
  await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
  if (records.some((record) => record.status === "inconclusive")) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  const result = await Result.tryPromise(run);
  if (Result.isError(result)) {
    console.error(
      "Native image canary failed before producing a complete report.",
    );
    process.exitCode = 1;
  }
}
