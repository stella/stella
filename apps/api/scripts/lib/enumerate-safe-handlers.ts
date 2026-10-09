import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
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
// export a handler module exposes (the default export and any named exports),
// NOT Elysia route introspection: the `mcp` field lives on the endpoint config
// and is never threaded into the route wiring, so the composed app cannot see
// it. An endpoint's identifier is its repo-relative module path for the default
// export, or `path#exportName` for a named export.
import {
  type HandlerKind,
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
 * Only import files that textually contain a safe-handler factory call. The
 * handlers tree also holds pure helpers and standalone CLI scripts (e.g.
 * case-law/seed-court-weights.ts, which runs a DB seed and process.exit at
 * module top level); importing those would execute their side effects and can
 * kill the process. Files without a factory call cannot define an endpoint
 * config, so skipping them without importing is sound.
 *
 * Global so `String.prototype.match` can count call sites per file for the
 * hidden-endpoint invariant. The trailing `[<(]` excludes bare identifier
 * mentions (imports, re-exports) and only matches a call or generic
 * instantiation, so an `import { createSafeHandler }` line is never counted.
 */
const SAFE_HANDLER_CALL_PATTERN = new RegExp(
  `(?:${SAFE_HANDLER_FACTORY_NAMES.join("|")})[<(]`,
  "gu",
);

/**
 * Detection is textual (per file, which factories are called) because the
 * scope is a property of the factory, not something the runtime config
 * carries.
 */
const FACTORY_KIND_PATTERNS = Object.entries(SAFE_HANDLER_FACTORIES).map(
  ([name, { kind }]) => ({ kind, pattern: new RegExp(`${name}[<(]`, "u") }),
);

/** The distinct factory kinds a file's source textually calls. */
const detectHandlerKinds = (source: string): HandlerKind[] => {
  const kinds = new Set<HandlerKind>();
  for (const { kind, pattern } of FACTORY_KIND_PATTERNS) {
    if (pattern.test(source)) {
      kinds.add(kind);
    }
  }
  return [...kinds];
};

export type ParsedExposure =
  | { type: "tool"; name: string; readClass?: McpReadClass }
  | { type: "covered"; by: string; readClass?: McpReadClass }
  | {
      type: "capability";
      reason: string;
      consumesServices: ServiceClassification;
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
  if (
    type === "capability" &&
    typeof reason === "string" &&
    isServiceClassification(consumesServices)
  ) {
    return {
      type: "capability",
      reason,
      consumesServices,
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

const ELYSIA_INSTANCE_PATTERN = /\bnew Elysia\s*\(/u;

export type SafeHandlerDiscovery = {
  endpoints: DiscoveredEndpoint[];
  files: DiscoveredFile[];
  /**
   * Every handler-tree file that builds an Elysia instance, whatever its name
   * and whether or not it defines handlers itself: route hooks live there.
   */
  routeFiles: { id: string; source: string }[];
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
  // approach as exact-mirror-guard and the coverage guard).
  await import("../../src/tests/setup-env");
  const { Glob } = await import("bun");
  const glob = new Glob(HANDLERS_GLOB);

  const endpoints: DiscoveredEndpoint[] = [];
  const files: DiscoveredFile[] = [];
  const routeFiles: { id: string; source: string }[] = [];
  const importErrors: { id: string; message: string }[] = [];

  for await (const abs of glob.scan({ cwd: REPO_ROOT, absolute: true })) {
    if (abs.endsWith(".test.ts")) {
      continue;
    }
    const source = await Bun.file(abs).text();
    const id = toEndpointIdentifier(abs, REPO_ROOT);
    if (ELYSIA_INSTANCE_PATTERN.test(source)) {
      routeFiles.push({ id, source });
    }
    const callCount = (source.match(SAFE_HANDLER_CALL_PATTERN) ?? []).length;
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
      kinds: detectHandlerKinds(source),
    });
  }

  endpoints.sort((a, b) => compareCodeUnit(a.id, b.id));
  files.sort((a, b) => compareCodeUnit(a.id, b.id));
  routeFiles.sort((a, b) => compareCodeUnit(a.id, b.id));
  return { endpoints, files, routeFiles, importErrors };
};
