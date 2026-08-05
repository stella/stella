import type { MCPToolSource } from "@tanstack/ai";
import { panic } from "better-result";
import * as v from "valibot";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";

/**
 * Last-line guard for the "tenant workspace ids reach the model only as chat
 * refs" invariant, applied where every provider-bound surface converges in
 * `streamChat`. The tool-egress side already fails closed per tool
 * (`projectForChat`'s UUID invariant); this covers the ingress side, where the exact
 * tenant set is known per request (the accessible-workspace ids are already
 * loaded on every send), so membership checks are precise: no pattern
 * heuristics, no false positives on public UUIDs (case-law decision ids,
 * entity-version handles).
 *
 * Enforcement is graduated by who authored the surface:
 * - the system prompt is entirely server-built, so a hit is a Stella bug and
 *   panics (fail closed);
 * - tool schemas may include org-configured external MCP tools, so a hit is
 *   captured to telemetry rather than taking the org's chat down;
 * - messages carry user-authored and historical text, so hits are redacted
 *   in place (the model loses an id it could not use legitimately anyway)
 *   and captured to telemetry with the message path, never the value.
 */

export const TENANT_ID_REDACTION_PLACEHOLDER = "[internal-id-removed]";

const findTenantId = (
  text: string,
  workspaceIds: readonly string[],
): string | undefined => workspaceIds.find((id) => text.includes(id));

export type ModelIngressSurface = "system-prompt" | "tool-schemas";

/**
 * Panic when a fully server-built surface embeds a tenant workspace id. The
 * error message and telemetry name the surface, never the value.
 */
export const assertModelSurfaceFreeOfTenantIds = ({
  serialized,
  surface,
  workspaceIds,
}: {
  serialized: string;
  surface: ModelIngressSurface;
  workspaceIds: readonly SafeId<"workspace">[];
}): void => {
  if (findTenantId(serialized, workspaceIds) === undefined) {
    return;
  }
  const error = new TelemetryError({
    message: `Model-bound ${surface} embeds a tenant workspace id`,
  });
  captureError(error, { source: "model-ingress-guard", surface });
  if (surface === "system-prompt") {
    panic(error.message);
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

type RedactionState = { paths: string[] };

const redactString = (
  value: string,
  workspaceIds: readonly string[],
  path: string,
  state: RedactionState,
): string => {
  let redacted = value;
  for (const id of workspaceIds) {
    if (redacted.includes(id)) {
      state.paths.push(path);
      redacted = redacted.replaceAll(id, () => TENANT_ID_REDACTION_PLACEHOLDER);
    }
  }
  return redacted;
};

/**
 * Mutate a structuredClone'd container in place, replacing tenant ids inside
 * every nested string. In-place mutation (instead of a rebuilding map) keeps
 * the entry point's return type the caller's own `T` without a cast. Dates,
 * class instances, and scalars pass through untouched.
 */
const redactContainerInPlace = (
  container: Record<string, unknown> | unknown[],
  workspaceIds: readonly string[],
  path: string,
  state: RedactionState,
): void => {
  const visit = (entry: unknown, key: string | number, entryPath: string) => {
    if (typeof entry === "string") {
      const redacted = redactString(entry, workspaceIds, entryPath, state);
      if (redacted !== entry) {
        if (Array.isArray(container) && typeof key === "number") {
          container[key] = redacted;
        } else if (!Array.isArray(container) && typeof key === "string") {
          container[key] = redacted;
        }
      }
      return;
    }
    if (Array.isArray(entry) || isPlainObject(entry)) {
      redactContainerInPlace(entry, workspaceIds, entryPath, state);
    }
  };

  if (Array.isArray(container)) {
    for (const [index, entry] of container.entries()) {
      visit(entry, index, `${path}[${index}]`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(container)) {
    visit(entry, key, `${path}.${key}`);
  }
};

export type RedactTenantIdsResult<T> = {
  value: T;
  /** Structural paths where an id was redacted; never the id itself. */
  redactedPaths: readonly string[];
};

/**
 * Deep-copy `value` with every occurrence of a tenant workspace id inside any
 * string replaced by `TENANT_ID_REDACTION_PLACEHOLDER`. Hits are captured to
 * telemetry by path so residual ingress leaks stay visible while chat keeps
 * working for threads whose history predates ref mediation.
 */
export const redactTenantIdsDeep = <T extends object>({
  value,
  workspaceIds,
}: {
  value: T;
  workspaceIds: readonly SafeId<"workspace">[];
}): RedactTenantIdsResult<T> => {
  const state: RedactionState = { paths: [] };
  const redacted = structuredClone(value);
  if (Array.isArray(redacted) || isPlainObject(redacted)) {
    redactContainerInPlace(redacted, workspaceIds, "$", state);
  }
  if (state.paths.length > 0) {
    captureError(
      new TelemetryError({
        message: "Model-bound message content embedded tenant workspace ids",
      }),
      {
        source: "model-ingress-guard",
        surface: "messages",
        paths: state.paths.slice(0, 20).join(", "),
      },
    );
  }
  return { value: redacted, redactedPaths: state.paths };
};

/**
 * Branded provider-bound surfaces. The brands are mintable only by the
 * `guardModel*` entry points below (their schemas stay module-private), and
 * the chat dispatch in `streamChat` accepts nothing else, so a surface that
 * skipped the guard — or was rebuilt after it ran — fails typecheck instead
 * of silently reaching the model.
 */
const guardedSystemPromptSchema = v.pipe(
  v.string(),
  v.brand("GuardedSystemPrompt"),
);

export type GuardedSystemPrompt = v.InferOutput<
  typeof guardedSystemPromptSchema
>;

export type GuardedToolSchemas<TTools extends readonly object[]> = TTools &
  v.Brand<"GuardedToolSchemas">;

export type GuardedModelMessages<TMessages extends readonly object[]> =
  TMessages & v.Brand<"GuardedModelMessages">;

const isList = (value: unknown): boolean => Array.isArray(value);

const brandToolSchemas = <TTools extends readonly object[]>(
  tools: TTools,
): GuardedToolSchemas<TTools> =>
  v.parse(
    v.pipe(v.custom<TTools>(isList), v.brand("GuardedToolSchemas")),
    tools,
  );

const brandModelMessages = <TMessages extends readonly object[]>(
  messages: TMessages,
): GuardedModelMessages<TMessages> =>
  v.parse(
    v.pipe(v.custom<TMessages>(isList), v.brand("GuardedModelMessages")),
    messages,
  );

/** Guard the assembled system prompt (panics on a hit) and brand it. */
export const guardModelSystemPrompt = ({
  system,
  workspaceIds,
}: {
  system: string;
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedSystemPrompt => {
  assertModelSurfaceFreeOfTenantIds({
    serialized: system,
    surface: "system-prompt",
    workspaceIds,
  });
  return v.parse(guardedSystemPromptSchema, system);
};

/** Guard the provider-bound tool schemas (telemetry on a hit) and brand them. */
export const guardModelToolSchemas = <TTools extends readonly object[]>({
  tools,
  workspaceIds,
}: {
  tools: TTools;
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedToolSchemas<TTools> => {
  assertModelSurfaceFreeOfTenantIds({
    serialized: JSON.stringify(tools),
    surface: "tool-schemas",
    workspaceIds,
  });
  return brandToolSchemas(tools);
};

/** Redact tenant ids out of the provider-bound messages and brand the copy. */
export const guardModelMessages = <TMessages extends readonly object[]>({
  messages,
  workspaceIds,
}: {
  messages: TMessages;
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedModelMessages<TMessages> =>
  brandModelMessages(
    redactTenantIdsDeep({ value: messages, workspaceIds }).value,
  );

/**
 * Brand a system prompt that is not fully server-built — it interpolates model
 * output, tool names from org-configured connectors, or user text — so a hit
 * is redacted and reported instead of taking the turn down. Prompts Stella
 * assembles end to end keep the fail-closed treatment of
 * `guardModelSystemPrompt`; this is for the mixed-provenance ones.
 */
export const redactModelSystemPrompt = ({
  system,
  workspaceIds,
}: {
  system: string;
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedSystemPrompt => {
  const state: RedactionState = { paths: [] };
  const redacted = redactString(system, workspaceIds, "$", state);
  if (state.paths.length > 0) {
    captureError(
      new TelemetryError({
        message: "Model-bound system prompt embedded tenant workspace ids",
      }),
      { source: "model-ingress-guard", surface: "system-prompt" },
    );
  }
  return v.parse(guardedSystemPromptSchema, redacted);
};

/**
 * An MCP tool source whose fetched schemas have passed the guard. Org
 * connectors serve their tool list lazily, mid-run, so the fetch itself has to
 * be wrapped: guarding the source object once at assembly would only cover the
 * empty shell the provider SDK later calls `tools()` on.
 */
export type GuardedMcpToolSource = MCPToolSource &
  v.Brand<"GuardedMcpToolSource">;

const guardedMcpToolSourceSchema = v.pipe(
  v.custom<MCPToolSource>(
    (value) => typeof value === "object" && value !== null,
  ),
  v.brand("GuardedMcpToolSource"),
);

/**
 * Wrap an MCP tool source so every lazily fetched schema batch passes the
 * tool-schema guard (telemetry, never a panic: the descriptions belong to the
 * org's connectors, and a hit must not brick chat).
 */
export const guardMcpToolSource = ({
  source,
  workspaceIds,
}: {
  source: MCPToolSource;
  workspaceIds: readonly SafeId<"workspace">[];
}): GuardedMcpToolSource => {
  const guarded: MCPToolSource = {
    ...source,
    tools: async (options) =>
      guardModelToolSchemas({
        tools: await source.tools(options),
        workspaceIds,
      }),
  };
  return v.parse(guardedMcpToolSourceSchema, guarded);
};
