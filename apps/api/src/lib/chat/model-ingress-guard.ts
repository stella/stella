import { panic } from "better-result";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";

/**
 * Last-line guard for the "tenant workspace ids reach the model only as chat
 * refs" invariant, applied where every provider-bound surface converges in
 * `streamChat`. The tool-egress side already fails closed per tool
 * (`findUndeclaredUuidPath`); this covers the ingress side, where the exact
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
