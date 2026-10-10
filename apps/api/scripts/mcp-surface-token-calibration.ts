import { Result, TaggedError } from "better-result";
// Manual calibration of the chars-per-token ratios `mcp-surface-baseline.ts`
// prints beside a drift. For each MCP audience it asks the Anthropic
// count_tokens endpoint for one request with and without the audience's tools
// (as a Messages API host sends them: name, description, input schema) and
// with and without its instructions, and divides the measured characters by
// the token delta. The API adds a fixed preamble once any tool is present, so
// tool deltas are taken over a request carrying one minimal tool rather than
// none. Run it when retuning those ratios; never in CI, since it needs a key
// and the network.
//
//   ANTHROPIC_API_KEY=... bun run mcp:surface-token-calibration [--model <id>]
//
// The default model is the catalog's Anthropic chat default; token counts are
// per tokenizer, so a ratio holds for the model family it was measured on.
import * as v from "valibot";

import { DEFAULT_MODELS } from "@stll/ai-catalog";
import { printError } from "@stll/errors";

import { MCP_MODES } from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import { toMcpTools } from "@/api/mcp/gateway/list-tools";
import { MCP_INSTRUCTIONS } from "@/api/mcp/instructions";
import { listStaticMcpToolDefinitions } from "@/api/mcp/static-tool-definitions";

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const ANTHROPIC_VERSION = "2023-06-01";
const COUNT_TOKENS_TIMEOUT_MS = 30_000;
// The smallest valid conversation; every count below is a delta over it.
const PROBE_MESSAGES = [{ role: "user", content: "." }] as const;
// Carries the tool-use preamble at the cost of a few tokens of its own.
const MINIMAL_TOOL = {
  name: "probe",
  input_schema: { type: "object" },
} as const;

class CountTokensError extends TaggedError("CountTokensError")<{
  message: string;
}> {}

const countTokensResponseSchema = v.object({
  input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

type AnthropicToolEntry = {
  name: string;
  description?: string;
  input_schema: unknown;
};

type CountRequest = {
  system?: string;
  tools?: readonly AnthropicToolEntry[];
};

type CountTokensOptions = {
  apiKey: string;
  model: string;
  request: CountRequest;
};

const countTokens = async ({
  apiKey,
  model,
  request,
}: CountTokensOptions): Promise<Result<number, CountTokensError>> => {
  const response = await Result.tryPromise({
    try: async () => {
      const reply = await fetch(COUNT_TOKENS_URL, {
        method: "POST",
        headers: {
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ model, messages: PROBE_MESSAGES, ...request }),
        signal: AbortSignal.timeout(COUNT_TOKENS_TIMEOUT_MS),
      });
      const body: unknown = await reply.json();
      return { ok: reply.ok, status: reply.status, body };
    },
    catch: (cause) =>
      new CountTokensError({
        message: `count_tokens request failed: ${String(cause)}`,
      }),
  });
  if (Result.isError(response)) {
    return response;
  }
  const { ok, status, body } = response.value;
  const parsed = v.safeParse(countTokensResponseSchema, body);
  if (!ok || !parsed.success) {
    return Result.err(
      new CountTokensError({
        message: `count_tokens answered ${status}: ${JSON.stringify(body)}`,
      }),
    );
  }
  return Result.ok(parsed.output.input_tokens);
};

type SurfaceCalibration = {
  mode: McpMode;
  schemaChars: number;
  schemaTokens: number;
  descriptionChars: number;
  descriptionTokens: number;
  instructionsChars: number;
  instructionsTokens: number;
};

type CalibrateOptions = {
  apiKey: string;
  model: string;
  mode: McpMode;
  baseTokens: number;
  toolBaseTokens: number;
};

const calibrateSurface = async ({
  apiKey,
  model,
  mode,
  baseTokens,
  toolBaseTokens,
}: CalibrateOptions): Promise<Result<SurfaceCalibration, CountTokensError>> =>
  await Result.gen(async function* () {
    const tools = toMcpTools(listStaticMcpToolDefinitions(mode), { mode });
    const bareTools = tools.map(({ name, inputSchema }) => ({
      name,
      input_schema: inputSchema,
    }));
    const describedTools = tools.map(
      ({ name, description, inputSchema }): AnthropicToolEntry => ({
        name,
        ...(description === undefined ? {} : { description }),
        input_schema: inputSchema,
      }),
    );
    const instructions = MCP_INSTRUCTIONS[mode];

    // Both carry the probe tool, so subtracting `toolBaseTokens` removes the
    // preamble and the probe and leaves only the audience's own tools.
    const bare = yield* Result.await(
      countTokens({
        apiKey,
        model,
        request: { tools: [MINIMAL_TOOL, ...bareTools] },
      }),
    );
    const described = yield* Result.await(
      countTokens({
        apiKey,
        model,
        request: { tools: [MINIMAL_TOOL, ...describedTools] },
      }),
    );
    const withInstructions = yield* Result.await(
      countTokens({ apiKey, model, request: { system: instructions } }),
    );

    return Result.ok({
      mode,
      schemaChars: tools.reduce(
        (sum, { name, inputSchema }) =>
          sum + name.length + JSON.stringify(inputSchema).length,
        0,
      ),
      schemaTokens: bare - toolBaseTokens,
      descriptionChars: tools.reduce(
        (sum, { description }) => sum + (description ?? "").length,
        0,
      ),
      descriptionTokens: described - bare,
      instructionsChars: instructions.length,
      instructionsTokens: withInstructions - baseTokens,
    });
  });

const ratio = (chars: number, tokens: number): string =>
  tokens > 0 ? (chars / tokens).toFixed(2) : "n/a";

const formatCalibration = (calibration: SurfaceCalibration): string =>
  [
    `${calibration.mode}:`,
    `  names + input schemas: ${calibration.schemaChars} chars / ${calibration.schemaTokens} tokens = ${ratio(calibration.schemaChars, calibration.schemaTokens)}`,
    `  descriptions:          ${calibration.descriptionChars} chars / ${calibration.descriptionTokens} tokens = ${ratio(calibration.descriptionChars, calibration.descriptionTokens)}`,
    `  instructions:          ${calibration.instructionsChars} chars / ${calibration.instructionsTokens} tokens = ${ratio(calibration.instructionsChars, calibration.instructionsTokens)}`,
  ].join("\n");

const readModelArgument = (): string => {
  const index = process.argv.indexOf("--model");
  return index === -1
    ? DEFAULT_MODELS.anthropic.chat
    : (process.argv.at(index + 1) ?? DEFAULT_MODELS.anthropic.chat);
};

const main = async (): Promise<number> => {
  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (apiKey === "") {
    console.error(
      "Set ANTHROPIC_API_KEY to calibrate; this script calls the Anthropic count_tokens endpoint.",
    );
    return 1;
  }
  const model = readModelArgument();
  const base = await countTokens({ apiKey, model, request: {} });
  if (Result.isError(base)) {
    printError(base.error);
    return 1;
  }
  const toolBase = await countTokens({
    apiKey,
    model,
    request: { tools: [MINIMAL_TOOL] },
  });
  if (Result.isError(toolBase)) {
    printError(toolBase.error);
    return 1;
  }

  console.log(
    `chars per token, ${model}, ${new Date().toISOString().slice(0, 10)}\n`,
  );
  for (const mode of MCP_MODES) {
    // Sequential on purpose: a handful of calls, and the endpoint is rate limited.
    const calibration = await calibrateSurface({
      apiKey,
      model,
      mode,
      baseTokens: base.value,
      toolBaseTokens: toolBase.value,
    });
    if (Result.isError(calibration)) {
      printError(calibration.error);
      return 1;
    }
    console.log(formatCalibration(calibration.value));
  }
  return 0;
};

if (import.meta.main) {
  process.exit(await main());
}
