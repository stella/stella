import { Result, TaggedError } from "better-result";
import { parseArgs } from "node:util";
import * as v from "valibot";

import {
  isBYOKModelRoleSupported,
  nativeImageProbeReportSchema,
} from "@stll/ai-catalog";
import type { HeicMimeType, NativeImageProbeRecord } from "@stll/ai-catalog";

import { toSafeId } from "@/api/lib/branded-types";
import {
  generateTanStackObjectForRole,
  resolveTanStackTextModel,
} from "@/api/lib/tanstack-ai-generate";
import { buildWorkflowFileMessages } from "@/api/lib/workflow/ai-generate-batch";

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
const MIME_TYPES = [
  "image/heic",
  "image/heif",
] as const satisfies readonly HeicMimeType[];
const ADAPTER_PACKAGES = {
  google: "@tanstack/ai-gemini",
  openrouter: "@tanstack/ai-openrouter",
  openai: "@tanstack/ai-openai",
  anthropic: "@tanstack/ai-anthropic",
  bedrock: "@tanstack/ai-bedrock",
  mistral: "@tanstack/ai-mistral",
} as const satisfies Record<CanaryProvider, string>;

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
      const status = Reflect.get(error, key);
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
  const model = resolveTanStackTextModel({
    role: "chat",
    orgAIConfig,
    organizationId: null,
  });
  if (model.provider !== provider || model.modelId !== modelId) {
    throw new NativeImageCanaryError({
      message: "Native image probe resolved a different model",
    });
  }
  const output = await generateTanStackObjectForRole({
    role: "chat",
    orgAIConfig,
    organizationId: null,
    tenantWorkspaceIds: [],
    serviceTier: "standard",
    caching: { enabled: false, reason: "org-disabled" },
    abortSignal: signal,
    maxOutputTokens: modelRoleMaxOutputTokens({ modelId, role: "chat" }),
    messages: [
      {
        role: "user",
        content: [
          ...buildWorkflowFileMessages([
            {
              kind: "native-image",
              fileFieldId: toSafeId<"field">("synthetic-native-image"),
              fileId: "synthetic-native-image",
              simplifiedName: "F0",
              content: bytes,
              mimeType,
            },
          ]),
          {
            type: "text",
            content:
              "Read the single alphanumeric identifier printed in the image. Return it verbatim as token. Do not guess if the image cannot be read.",
          },
        ],
      },
    ],
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
