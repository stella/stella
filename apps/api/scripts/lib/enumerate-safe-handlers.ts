import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { parseSource, walk } from "@stll/scripts/src/syntax-tree";
import { loadLocalModule } from "@stll/start-runtime/local-module-loader";

import {
  isServiceClassification,
  type ServiceClassification,
} from "../../src/lib/rate-limit/service-classification";
// Shared safe-handler enumeration.
//
// The MCP coverage guard (`apps/api/scripts/mcp-coverage-guard.ts`) and the
// capability-catalog exporter (`apps/api/scripts/export-capability-catalog.ts`)
// both need the same "enumerate every `{ config, handler }` export in the
// handler tree" machinery. It lives here so there is exactly one definition of
// the handler universe; a change to discovery (glob, factory detection, module
// enumeration) moves both consumers together.
//
// Enumeration is by module glob + dynamic import of every `{ config, handler }`
// export a handler module exposes (the default export and any named exports).
// The route table mounts these same definition objects, so a consumer can join
// an endpoint to its mounted routes by identity. An endpoint's identifier is its repo-relative module path for the default
// export, or `path#exportName` for a named export.
import {
  type HandlerKind,
  isSafeHandlerFactory,
  SAFE_HANDLER_FACTORIES,
  SAFE_HANDLER_FACTORY_NAMES,
} from "../../src/lib/safe-handler-factories";
import type { McpReadClass } from "../../src/mcp/tool-types";

// Repo root resolved from this file's location so identifiers are stable
// regardless of the process working directory. This file sits at
// `apps/api/scripts/lib/`, so the repo root is four levels up.
const LIB_DIR = import.meta.dir;
export const REPO_ROOT = path.resolve(LIB_DIR, "../../../..");
export const HANDLERS_GLOB = "apps/api/src/handlers/**/*.ts";

/**
 * Only import files that contain a safe-handler factory call. The
 * handlers tree also holds pure helpers and standalone CLI scripts (e.g.
 * case-law/seed-court-weights.ts, which runs a DB seed and process.exit at
 * module top level); importing those would execute their side effects and can
 * kill the process. Files without a factory call cannot define an endpoint
 * config, so skipping them without importing is sound.
 *
 * Parse actual call expressions: type queries and runtime generic
 * instantiations reference factories without constructing endpoints.
 */
// Every subtree that holds only types: annotations, type arguments and
// parameters, aliases, interfaces and `implements` clauses.
const TYPE_POSITIONS = new Set([
  "TSTypeAnnotation",
  "TSTypeParameterInstantiation",
  "TSTypeParameterDeclaration",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSClassImplements",
]);

export const inspectSafeHandlerCalls = (source: string) => {
  const kinds = new Set<HandlerKind>();
  let callCount = 0;
  if (!SAFE_HANDLER_FACTORY_NAMES.some((name) => source.includes(name))) {
    return { callCount, kinds: [...kinds] };
  }
  walk(parseSource("handler.ts", source).program, (node) => {
    if (TYPE_POSITIONS.has(node.type)) {
      return "skip-children";
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      isSafeHandlerFactory(node.callee.name)
    ) {
      callCount += 1;
      kinds.add(SAFE_HANDLER_FACTORIES[node.callee.name].kind);
    }
    return undefined;
  });
  return { callCount, kinds: [...kinds] };
};

export type ParsedExposure =
  | { type: "tool"; name: string; readClass?: McpReadClass }
  | { type: "covered"; by: string; readClass?: McpReadClass }
  | {
      type: "capability";
      reason: string;
      consumesServices: ServiceClassification;
      confirmation?: "required";
      readClass?: McpReadClass;
    }
  | { type: "internal"; reason: string }
  | { type: "pending" }
  | { type: "invalid"; raw: unknown };

/** Repo-relative identifier for an endpoint module (stable across machines). */
export const toEndpointIdentifier = (
  absPath: string,
  repoRoot: string,
): string => {
  const normalizedRoot = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return absPath.startsWith(normalizedRoot)
    ? absPath.slice(normalizedRoot.length)
    : absPath;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrow an unknown default export to an endpoint definition shape. */
export const isEndpointModule = (
  value: unknown,
): value is { config: Record<string, unknown>; handler: unknown } => {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value["handler"] === "function" && isRecord(value["config"]);
};

/** Parse a config's `mcp` value into a discriminated result. */
export const parseExposure = (mcp: unknown): ParsedExposure => {
  if (!isRecord(mcp)) {
    return { type: "invalid", raw: mcp };
  }
  const readClass = mcp["readClass"];
  if (
    readClass !== undefined &&
    readClass !== "tenant" &&
    readClass !== "public" &&
    readClass !== "both"
  ) {
    return { type: "invalid", raw: mcp };
  }
  const readClassification =
    readClass === undefined ? {} : ({ readClass } as const);
  const type = mcp["type"];
  if (type === "pending") {
    return { type: "pending" };
  }
  const name = mcp["name"];
  if (type === "tool" && typeof name === "string") {
    return { type: "tool", name, ...readClassification };
  }
  const by = mcp["by"];
  if (type === "covered" && typeof by === "string") {
    return { type: "covered", by, ...readClassification };
  }
  const reason = mcp["reason"];
  const consumesServices = mcp["consumesServices"];
  const confirmation = mcp["confirmation"];
  if (confirmation !== undefined && confirmation !== "required") {
    return { type: "invalid", raw: mcp };
  }
  if (
    type === "capability" &&
    typeof reason === "string" &&
    isServiceClassification(consumesServices)
  ) {
    return {
      type: "capability",
      reason,
      consumesServices,
      ...(confirmation === undefined ? {} : { confirmation }),
      ...readClassification,
    };
  }
  if (type === "internal" && typeof reason === "string") {
    return { type: "internal", reason };
  }
  return { type: "invalid", raw: mcp };
};

/** An endpoint export with its raw config, discovered from a module. */
export type CollectedEndpoint = {
  /** Module id for the default export, `moduleId#exportName` for a named one. */
  id: string;
  /** `undefined` for the default export, the export name otherwise. */
  exportName: string | undefined;
  /** The exported definition itself, the object the route table mounts. */
  definition: object;
  config: Record<string, unknown>;
  exposure: ParsedExposure;
};

/**
 * Collect every `{ config, handler }` export a module exposes as an endpoint,
 * deduplicated by object identity, carrying the raw config. The default export
 * takes the plain module id; a named export takes `id#exportName`. An object
 * exported as both default and a name is recorded once under the default id, so
 * existing baseline entries stay valid. Pure (a plain record in, no I/O).
 */
const collectModuleEndpoints = (
  mod: Record<string, unknown>,
  moduleId: string,
): CollectedEndpoint[] => {
  const endpoints: CollectedEndpoint[] = [];
  const claimed = new Set<object>();

  const defaultExport = mod["default"];
  if (isEndpointModule(defaultExport)) {
    claimed.add(defaultExport);
    endpoints.push({
      id: moduleId,
      exportName: undefined,
      definition: defaultExport,
      config: defaultExport.config,
      exposure: parseExposure(defaultExport.config["mcp"]),
    });
  }

  for (const [key, value] of Object.entries(mod)) {
    if (key === "default" || !isEndpointModule(value) || claimed.has(value)) {
      continue;
    }
    claimed.add(value);
    endpoints.push({
      id: `${moduleId}#${key}`,
      exportName: key,
      definition: value,
      config: value.config,
      exposure: parseExposure(value.config["mcp"]),
    });
  }

  return endpoints;
};

/**
 * Projection kept for the coverage guard's existing contract (and its test
 * suite): the endpoint id and its parsed exposure, without the raw config.
 */
export const enumerateModuleEndpoints = (
  mod: Record<string, unknown>,
  moduleId: string,
): { id: string; exposure: ParsedExposure }[] =>
  collectModuleEndpoints(mod, moduleId).map(({ id, exposure }) => ({
    id,
    exposure,
  }));

type DiscoveredEndpoint = CollectedEndpoint & {
  /** Repo-relative path of the file this endpoint was discovered in. */
  file: string;
};

type DiscoveredFile = {
  /** Repo-relative file path. */
  id: string;
  callCount: number;
  enumerableCount: number;
  source: string;
  kinds: HandlerKind[];
};

export type SafeHandlerDiscovery = {
  endpoints: DiscoveredEndpoint[];
  files: DiscoveredFile[];
  importErrors: { id: string; message: string }[];
};

/**
 * Walk the handler tree once and dynamically import every module that calls a
 * safe-handler factory, returning the raw endpoints (with configs), per-file
 * bookkeeping (call-site count, enumerable count, source, factory kinds), and
 * any import failures. Results are sorted by id so downstream output is
 * deterministic.
 */
export const discoverSafeHandlers = async (): Promise<SafeHandlerDiscovery> => {
  // Seed env defaults so handler modules import without real services (same
  // approach as the coverage guard).
  await import("../../src/tests/setup-env");
  const { Glob } = await import("bun");
  const glob = new Glob(HANDLERS_GLOB);

  const endpoints: DiscoveredEndpoint[] = [];
  const files: DiscoveredFile[] = [];
  const importErrors: { id: string; message: string }[] = [];

  for await (const abs of glob.scan({ cwd: REPO_ROOT, absolute: true })) {
    if (abs.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(abs).text();
    const id = toEndpointIdentifier(abs, REPO_ROOT);
    const { callCount, kinds } = inspectSafeHandlerCalls(source);
    if (callCount === 0) {
      continue;
    }
    let mod: unknown;
    try {
      const loaded = await loadLocalModule({
        root: path.join(REPO_ROOT, "apps/api/src/handlers"),
        modulePath: abs,
      });
      if (loaded.isErr()) {
        throw loaded.error;
      }
      mod = loaded.value;
    } catch (error) {
      importErrors.push({
        id,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!isRecord(mod)) {
      continue;
    }
    const collected = collectModuleEndpoints(mod, id);
    for (const endpoint of collected) {
      endpoints.push({ ...endpoint, file: id });
    }
    files.push({
      id,
      callCount,
      enumerableCount: collected.length,
      source,
      kinds,
    });
  }

  endpoints.sort((a, b) => compareCodeUnit(a.id, b.id));
  files.sort((a, b) => compareCodeUnit(a.id, b.id));
  return { endpoints, files, importErrors };
};
