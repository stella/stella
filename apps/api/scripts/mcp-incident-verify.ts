import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { Ajv2019 } from "ajv/dist/2019";
import { Ajv2020 } from "ajv/dist/2020";
import { panic, Result, TaggedError } from "better-result";
import path from "node:path";
import { parseArgs } from "node:util";
import * as v from "valibot";

import { readBodyJsonWithIdleDeadline } from "@stll/fetch/body-reader";

import type {
  CanaryFetcher,
  createJsonRpcRequest,
} from "../src/scripts/mcp-canary";
import { MCP_CANARY_JOURNEY_CREDENTIALS } from "../src/scripts/mcp-canary-credentials";

const DEFAULT_BASE_URL = "https://api.stll.app";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY_SNAPSHOT = "packages/cli/src/generated/registry-snapshot.json";
const HEALTH_TIMEOUT_MS = 5000;
const SESSION_TIMEOUT_MS = 40_000;
const LOCAL_COMMAND_TIMEOUT_MS = 2000;
const CANARY_LOOKUP_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_LIST_PAGES = 32;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;
const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/u;
const BUILD_STAMP = /^(?:dev|[0-9a-f]{40}|v?\d+\.\d+\.\d+(?:-[\w.-]+)?)$/u;
const USAGE =
  "bun run incident:verify --tool <name> --args '<json>' [--base-url <url>] [--stale-list <path>]";

const jsonObject = v.pipe(
  v.unknown(),
  v.check((value) => !Array.isArray(value)),
  v.record(v.string(), v.unknown()),
);
const advertisedTool = v.object({
  name: v.string(),
  outputSchema: v.optional(jsonObject),
});
const toolsList = v.object({
  tools: v.array(advertisedTool),
  nextCursor: v.optional(v.string()),
});
const toolResult = v.object({
  content: v.array(v.unknown()),
  isError: v.optional(v.boolean()),
  structuredContent: v.optional(v.unknown()),
});
const rpcEnvelope = v.object({
  jsonrpc: v.literal("2.0"),
  id: v.number(),
  result: v.optional(v.unknown()),
  error: v.optional(v.object({ code: v.number() })),
});
const buildStamp = v.pipe(v.string(), v.maxLength(80), v.regex(BUILD_STAMP));
const buildIdentity = v.object({ version: buildStamp, commit: buildStamp });
const savedTools = v.union([
  v.pipe(
    toolsList,
    v.transform(({ tools }) => tools),
  ),
  v.pipe(
    v.object({ result: toolsList }),
    v.transform(({ result }) => result.tools),
  ),
  v.array(advertisedTool),
]);

type AdvertisedTool = v.InferOutput<typeof advertisedTool>;
type ToolResult = v.InferOutput<typeof toolResult>;

type FreshProbe =
  | { type: "list_failed"; detail: string }
  | { type: "server_error"; detail: string }
  | { type: "not_listed" }
  | { type: "returned"; tool: AdvertisedTool; result: ToolResult };

type StaleList =
  | { type: "available"; source: string; tools: readonly AdvertisedTool[] }
  | { type: "unavailable"; detail: string };

const CLASSIFICATION = {
  allClients: { label: "ALL CLIENTS BROKEN", exitCode: 1 },
  staleOnly: { label: "STALE SESSIONS ONLY", exitCode: 2 },
  notReproduced: { label: "NOT REPRODUCED", exitCode: 0 },
  serverError: { label: "SERVER ERROR", exitCode: 3 },
} as const;

// The SDK defaults to 2020-12 and uses the declared dialect for older lists.
const schemaEngine = (dialect: unknown) => {
  const settings = {
    strict: true,
    allowUnionTypes: true,
    logger: false,
  } as const;
  if (typeof dialect === "string" && /\/draft-0[67]\//u.test(dialect)) {
    return new Ajv(settings);
  }
  if (typeof dialect === "string" && dialect.includes("/2019-09/")) {
    return new Ajv2019(settings);
  }
  return new Ajv2020(settings);
};

const checkOutput = (tool: AdvertisedTool, result: ToolResult) => {
  const schema = tool.outputSchema;
  if (schema === undefined) {
    return { type: "skipped", detail: "no outputSchema advertised" } as const;
  }
  if (result.structuredContent === undefined) {
    return { type: "failed", detail: "structuredContent is missing" } as const;
  }

  if (schema["$async"] === true) {
    return {
      type: "invalid_schema",
      detail: "outputSchema requests asynchronous validation",
    } as const;
  }
  const validated = Result.try(() => {
    const ajv = schemaEngine(schema["$schema"]);
    addFormats(ajv);
    const validate = ajv.compile(schema);
    // Only report the schema keyword. Ajv's message and path can contain data.
    return validate(result.structuredContent)
      ? ({
          type: "passed",
          detail: "structuredContent matches outputSchema",
        } as const)
      : ({
          type: "failed",
          detail: `structuredContent violates outputSchema (${validate.errors?.at(0)?.keyword ?? "validation"})`,
        } as const);
  });
  return validated.isOk()
    ? validated.value
    : ({
        type: "invalid_schema",
        detail: "strict Ajv could not compile outputSchema",
      } as const);
};

export const classifyMcpIncident = (fresh: FreshProbe, stale: StaleList) => {
  const skipped = "skipped because the fresh probe failed";
  switch (fresh.type) {
    case "list_failed":
      return {
        ...CLASSIFICATION.allClients,
        fresh: fresh.detail,
        stale: skipped,
      };
    case "not_listed":
      return {
        ...CLASSIFICATION.allClients,
        fresh: "tool absent from tools/list",
        stale: skipped,
      };
    case "server_error":
      return {
        ...CLASSIFICATION.serverError,
        fresh: fresh.detail,
        stale: skipped,
      };
    case "returned": {
      if (fresh.result.isError === true) {
        return {
          ...CLASSIFICATION.serverError,
          fresh: "tools/call returned isError",
          stale: skipped,
        };
      }
      const current = checkOutput(fresh.tool, fresh.result);
      if (current.type === "failed" || current.type === "invalid_schema") {
        return {
          ...CLASSIFICATION.allClients,
          fresh: current.detail,
          stale: skipped,
        };
      }
      if (stale.type === "unavailable") {
        return {
          ...CLASSIFICATION.notReproduced,
          fresh: current.detail,
          stale: stale.detail,
        };
      }
      const previousTool = stale.tools.find(
        (tool) => tool.name === fresh.tool.name,
      );
      const previous =
        previousTool === undefined
          ? { type: "skipped", detail: "tool absent from tools/list" }
          : checkOutput(previousTool, fresh.result);
      return {
        ...(previous.type === "failed"
          ? CLASSIFICATION.staleOnly
          : CLASSIFICATION.notReproduced),
        fresh: current.detail,
        stale: `${stale.source} · ${previous.detail}`,
      };
    }
    default:
      fresh satisfies never;
      return panic("Unhandled fresh probe result");
  }
};

class IncidentProbeError extends TaggedError("IncidentProbeError")<{
  message: string;
  status?: number;
}> {}

const readJson = async (
  fetcher: CanaryFetcher,
  request: Request,
  timeoutMs: number,
  signal = AbortSignal.timeout(timeoutMs),
) =>
  await Result.tryPromise({
    try: async () => {
      const response = await fetcher(request, {
        signal,
        timeout: { type: "headers", ms: timeoutMs },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new IncidentProbeError({
          message: `HTTP ${response.status}`,
          status: response.status,
        });
      }
      return await readBodyJsonWithIdleDeadline(response, {
        idleMs: timeoutMs,
        maxBytes: MAX_RESPONSE_BYTES,
        signal,
      });
    },
    catch: (cause) =>
      cause instanceof IncidentProbeError
        ? cause
        : new IncidentProbeError({
            message: "request failed or returned unreadable JSON",
          }),
  });

const probeFresh = async ({
  baseUrl,
  token,
  name,
  args,
  fetcher,
  createRequest,
}: {
  baseUrl: string;
  token: string;
  name: string;
  args: Record<string, unknown>;
  fetcher: CanaryFetcher;
  createRequest: typeof createJsonRpcRequest;
}): Promise<FreshProbe> => {
  // The canary's modern transport is stateless. Start with a fresh tools/list
  // and use the same target and credential for the one tools/call.
  const signal = AbortSignal.timeout(SESSION_TIMEOUT_MS);
  const rpc = async (request: Request, id: number) => {
    const received = await readJson(
      fetcher,
      request,
      SESSION_TIMEOUT_MS,
      signal,
    );
    if (received.isErr()) {
      return received;
    }
    const parsed = v.safeParse(rpcEnvelope, received.value);
    if (
      !parsed.success ||
      parsed.output.id !== id ||
      parsed.output.error !== undefined ||
      parsed.output.result === undefined
    ) {
      const code = parsed.success ? parsed.output.error?.code : undefined;
      return Result.err(
        new IncidentProbeError({
          message:
            code === undefined
              ? "invalid JSON-RPC response"
              : `JSON-RPC error ${code}`,
        }),
      );
    }
    return Result.ok(parsed.output.result);
  };

  const context = { baseUrl, token, era: "modern" as const };
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let id = 1; id <= MAX_LIST_PAGES; id += 1) {
    const page = await rpc(
      createRequest({
        ...context,
        method: "tools/list",
        id,
        params: cursor === undefined ? {} : { cursor },
      }),
      id,
    );
    if (page.isErr()) {
      const detail = `tools/list ${page.error.message}`;
      if (page.error.status === 401 || page.error.status === 403) {
        return { type: "server_error", detail };
      }
      return { type: "list_failed", detail };
    }
    const parsed = v.safeParse(toolsList, page.value);
    if (!parsed.success) {
      return { type: "list_failed", detail: "invalid tools/list result" };
    }
    const tool = parsed.output.tools.find((entry) => entry.name === name);
    if (tool !== undefined) {
      const callId = id + 1;
      const call = await rpc(
        createRequest({
          ...context,
          method: "tools/call",
          id: callId,
          params: { name, arguments: args },
        }),
        callId,
      );
      if (call.isErr()) {
        return {
          type: "server_error",
          detail: `tools/call ${call.error.message}`,
        };
      }
      const result = v.safeParse(toolResult, call.value);
      return result.success
        ? { type: "returned", tool, result: result.output }
        : { type: "server_error", detail: "invalid tools/call result" };
    }
    cursor = parsed.output.nextCursor;
    if (cursor === undefined) {
      return { type: "not_listed" };
    }
    if (cursors.has(cursor)) {
      return {
        type: "list_failed",
        detail: "tools/list repeated a pagination cursor",
      };
    }
    cursors.add(cursor);
  }
  return {
    type: "list_failed",
    detail: "tools/list exceeded the pagination limit",
  };
};

const commandOutput = (args: string[], timeout: number) => {
  const run = Result.try(() =>
    Bun.spawnSync(args, {
      cwd: REPO_ROOT,
      timeout,
      stdout: "pipe",
      stderr: "ignore",
    }),
  );
  return run.isOk() && run.value.exitCode === 0
    ? run.value.stdout.toString()
    : undefined;
};

const readStaleList = async (
  savedPath: string | undefined,
  deployedVersion: string | undefined,
): Promise<StaleList> => {
  if (savedPath !== undefined) {
    const file = Bun.file(path.resolve(REPO_ROOT, savedPath));
    if (file.size > MAX_RESPONSE_BYTES) {
      return {
        type: "unavailable",
        detail: "supplied tools/list exceeds the size limit",
      };
    }
    const json = await Result.tryPromise(
      async (): Promise<unknown> => await file.json(),
    );
    const parsed = json.isOk()
      ? v.safeParse(savedTools, json.value)
      : undefined;
    return parsed?.success === true
      ? { type: "available", source: "saved tools/list", tools: parsed.output }
      : {
          type: "unavailable",
          detail: "supplied tools/list is unreadable or invalid",
        };
  }
  if (deployedVersion === undefined || !RELEASE_VERSION.test(deployedVersion)) {
    return {
      type: "unavailable",
      detail: "no deployed release version for snapshot lookup",
    };
  }
  // Tag creation order follows the release line even where historical version
  // numbers were higher. Select the newest stable tag older than this build.
  const version = deployedVersion.replace(/^v/u, "");
  const tag = commandOutput(
    ["git", "tag", "--list", "--sort=-creatordate", "v*"],
    LOCAL_COMMAND_TIMEOUT_MS,
  )
    ?.split("\n")
    .find(
      (candidate) =>
        STABLE_TAG.test(candidate) &&
        Bun.semver.order(candidate.slice(1), version) < 0,
    );
  if (tag !== undefined) {
    const snapshot = commandOutput(
      [
        "git",
        "--no-lazy-fetch",
        "show",
        `refs/tags/${tag}:${REGISTRY_SNAPSHOT}`,
      ],
      LOCAL_COMMAND_TIMEOUT_MS,
    );
    const parsed = Result.try((): unknown => JSON.parse(snapshot ?? ""));
    const list = parsed.isOk()
      ? v.safeParse(savedTools, parsed.value)
      : undefined;
    if (list?.success === true) {
      return {
        type: "available",
        source: `${tag} registry snapshot`,
        tools: list.output,
      };
    }
  }
  return {
    type: "unavailable",
    detail: "no local prior stable registry snapshot",
  };
};

const canaryVerdict = (): string => {
  // GitHub reads go through the repository's retry owner.
  const output = commandOutput(
    [
      "bash",
      path.join(REPO_ROOT, "scripts/gh-retry.sh"),
      "run",
      "list",
      "--repo",
      "stella/stella",
      "--workflow",
      "mcp-canary.yml",
      "-L",
      "1",
      "--json",
      "conclusion,status,createdAt",
    ],
    CANARY_LOOKUP_TIMEOUT_MS,
  );
  const json = Result.try((): unknown => JSON.parse(output ?? ""));
  const parsed = json.isOk()
    ? v.safeParse(
        v.array(
          v.object({
            conclusion: v.pipe(v.string(), v.regex(/^[a-z_]*$/u)),
            status: v.pipe(v.string(), v.regex(/^[a-z_]+$/u)),
            createdAt: v.pipe(v.string(), v.isoTimestamp()),
          }),
        ),
        json.value,
      )
    : undefined;
  const latest = parsed?.success === true ? parsed.output.at(0) : undefined;
  return latest === undefined
    ? "unavailable (gh missing, inaccessible, or no runs)"
    : `${latest.conclusion || latest.status} at ${latest.createdAt}`;
};

const parseOrigin = (input: string): string => {
  const url = new URL(input);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new IncidentProbeError({
      message: "expected an HTTPS API origin or a loopback HTTP origin",
    });
  }
  return url.origin;
};

const run = async (): Promise<number> => {
  const cli = Result.try(
    () =>
      parseArgs({
        args: process.argv.slice(2),
        options: {
          "base-url": { type: "string" },
          tool: { type: "string" },
          args: { type: "string" },
          "stale-list": { type: "string" },
          help: { type: "boolean" },
        },
        allowPositionals: false,
      }).values,
  );
  if (cli.isOk() && cli.value.help) {
    console.log(USAGE);
    return 0;
  }
  const values = cli.isOk() ? cli.value : undefined;
  const name = values?.tool;
  const rawArgs = values?.args;
  if (values === undefined || !name || rawArgs === undefined) {
    console.log(USAGE);
    console.log(CLASSIFICATION.serverError.label);
    return CLASSIFICATION.serverError.exitCode;
  }
  const decoded = Result.try((): unknown => JSON.parse(rawArgs));
  const args = decoded.isOk()
    ? v.safeParse(jsonObject, decoded.value)
    : undefined;
  const origins = Result.try(() => {
    const configured = parseOrigin(
      process.env[
        MCP_CANARY_JOURNEY_CREDENTIALS.reviewAccount.env.configuredBaseUrl
      ] ?? DEFAULT_BASE_URL,
    );
    return {
      configured,
      target: parseOrigin(values["base-url"] ?? configured),
    };
  });
  if (args?.success !== true || origins.isErr()) {
    console.log(
      "Expected object JSON arguments and an HTTPS API origin or loopback HTTP origin.",
    );
    console.log(CLASSIFICATION.serverError.label);
    return CLASSIFICATION.serverError.exitCode;
  }
  if (process.env["CI"] === "true") {
    console.log("Incident verification runs outside CI.");
    console.log(CLASSIFICATION.serverError.label);
    return CLASSIFICATION.serverError.exitCode;
  }

  const { createDeploymentFetcher, createJsonRpcRequest } =
    await import("../src/scripts/mcp-canary");
  const { configured, target } = origins.value;
  const fetcher = createDeploymentFetcher({ baseUrl: target });
  const health = await readJson(
    fetcher,
    new Request(new URL("/health", target).href),
    HEALTH_TIMEOUT_MS,
  );
  const parsedHealth = health.isOk()
    ? v.safeParse(buildIdentity, health.value)
    : undefined;
  const identity =
    parsedHealth?.success === true ? parsedHealth.output : undefined;
  console.log(
    identity === undefined
      ? `Server /health · ${health.isErr() ? "unavailable" : "missing build identity"}`
      : `Server /health · version ${identity.version}, commit ${identity.commit}`,
  );

  const token =
    process.env[MCP_CANARY_JOURNEY_CREDENTIALS.productionBearer.env.token];
  const fresh =
    target !== configured || !token
      ? {
          type: "server_error" as const,
          detail:
            target !== configured
              ? "credential withheld outside the configured origin"
              : "MCP_CANARY_TOKEN is missing",
        }
      : await probeFresh({
          baseUrl: target,
          token,
          name,
          args: args.output,
          fetcher,
          createRequest: createJsonRpcRequest,
        });
  const stale =
    fresh.type === "returned" && fresh.result.isError !== true
      ? await readStaleList(values["stale-list"], identity?.version)
      : { type: "unavailable" as const, detail: "no successful tool result" };
  const verdict = classifyMcpIncident(fresh, stale);
  console.log(`Fresh session · ${verdict.fresh}`);
  console.log(`Stale schema · ${verdict.stale}`);
  console.log(`Latest MCP canary · ${canaryVerdict()}`);
  console.log(verdict.label);
  return verdict.exitCode;
};

if (import.meta.main) {
  const result = await Result.tryPromise(run);
  if (result.isErr()) {
    console.log("The verification could not complete. Check the local setup.");
    console.log(CLASSIFICATION.serverError.label);
    process.exitCode = CLASSIFICATION.serverError.exitCode;
  } else {
    process.exitCode = result.value;
  }
}
