// Executor for the generated `reference` resource commands (spec 051 S5.4).
// `reference list` enumerates `resources/list` as a table; `reference show
// <name>` reads the resource's fixed URI via `resources/read` and prints
// `contents[0].text`, honoring `--output`. Resources are public (no scope
// precheck); an unknown resource (server `resources/read` rejection) is exit 6.

import { Result } from "better-result";

import type { Context } from "./context.js";
import {
  listResources,
  type McpClientError,
  readResource,
} from "./mcp-client.js";
import { EXIT_CODES, type ExitCode } from "./mcp-constants.js";
import {
  renderResult,
  selectFormat,
  type OutputFormat,
  type Writers,
} from "./output.js";
import type { ResourceLeafSpec } from "./resource-types.js";
import { RESERVED_FLAG_KEYS } from "./run-leaf-command.js";

type LeafFlags = Record<string, unknown>;

const REFERENCE_COLUMNS = ["name", "title", "mimeType"] as const;

const writersFor = (context: Context): Writers => ({
  stdout: (text) => {
    context.process.stdout.write(text);
  },
  stderr: (text) => {
    context.process.stderr.write(text);
  },
});

const readOutputFormat = (flags: LeafFlags, context: Context): OutputFormat => {
  const output = flags[RESERVED_FLAG_KEYS.output];
  return selectFormat({
    flags: {
      output: output === "json" || output === "table" ? output : undefined,
      json: flags[RESERVED_FLAG_KEYS.json] === true,
      table: flags[RESERVED_FLAG_KEYS.table] === true,
    },
    isTTY: context.process.stdout.isTTY,
  });
};

/** Resources fail only with unknown-URI: any rpc/404 maps to not-found (spec S4). */
const mapResourceErrorExit = (error: McpClientError): ExitCode => {
  if (error.kind === "rpc") {
    return EXIT_CODES.notFound;
  }
  if (error.kind === "http") {
    if (error.httpStatus === 401) {
      return EXIT_CODES.auth;
    }
    if (error.httpStatus === 404) {
      return EXIT_CODES.notFound;
    }
    return EXIT_CODES.server;
  }
  return EXIT_CODES.server;
};

const runList = async ({
  context,
  serverUrl,
  token,
  format,
  writers,
}: {
  context: Context;
  serverUrl: string;
  token: string;
  format: OutputFormat;
  writers: Writers;
}): Promise<void> => {
  const result = await listResources({ serverUrl, token });
  if (Result.isError(result)) {
    writers.stderr(`${result.error.message}\n`);
    context.process.exitCode = mapResourceErrorExit(result.error);
    return;
  }
  const items = result.value.resources;
  renderResult({
    plan: {
      kind: "page",
      itemsKey: "resources",
      items,
      payload: { resources: items },
      nextCursor: null,
      columns: REFERENCE_COLUMNS,
    },
    format,
    writers,
    allActive: false,
  });
};

const runShow = async ({
  context,
  spec,
  serverUrl,
  token,
  format,
  writers,
}: {
  context: Context;
  spec: Extract<ResourceLeafSpec, { kind: "show" }>;
  serverUrl: string;
  token: string;
  format: OutputFormat;
  writers: Writers;
}): Promise<void> => {
  const result = await readResource({ serverUrl, token, uri: spec.uri });
  if (Result.isError(result)) {
    writers.stderr(`${result.error.message}\n`);
    context.process.exitCode = mapResourceErrorExit(result.error);
    return;
  }
  const text = result.value.contents.at(0)?.text ?? "";
  renderResult({
    plan: { kind: "windowed-text", text, nextCursor: null },
    format,
    writers,
    allActive: false,
  });
};

/** Run one generated `reference` command end to end (spec 051 S5.4). */
export const runResourceCommand = async ({
  context,
  flags,
  spec,
}: {
  context: Context;
  flags: LeafFlags;
  spec: ResourceLeafSpec;
}): Promise<void> => {
  const writers = writersFor(context);
  const { serverUrl, token } = context;
  if (serverUrl === undefined || token === undefined) {
    writers.stderr("Not signed in. Run 'stella auth login' to authenticate.\n");
    context.process.exitCode = EXIT_CODES.auth;
    return;
  }

  if (spec.kind === "list") {
    await runList({
      context,
      serverUrl,
      token,
      format: readOutputFormat(flags, context),
      writers,
    });
    return;
  }

  // `reference show` prints the resource text raw by default (like windowed-text
  // tool output); only an explicit --json/--output json wraps it (spec S5.4).
  const explicitJson =
    flags[RESERVED_FLAG_KEYS.json] === true ||
    flags[RESERVED_FLAG_KEYS.output] === "json";
  await runShow({
    context,
    spec,
    serverUrl,
    token,
    format: explicitJson ? "json" : "table",
    writers,
  });
};
