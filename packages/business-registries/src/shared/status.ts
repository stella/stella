// Cross-registry entity status — the boundary representation every adapter
// translates into. Adapters keep richer per-registry vocabularies internally
// for callers that need fidelity, but expose this normalised shape at the
// public surface.

export type EntityStatus =
  | { type: "active" }
  | { type: "inactive" }
  | { type: "liquidating" }
  | { type: "bankruptcy" }
  | { type: "dissolved" }
  | { type: "deleted"; at: string | null }
  | { type: "unknown" };

// Accept any runtime string for `internal` so undocumented or newly-added
// upstream status codes fall through to `{ type: "unknown" }` instead of
// landing in the return value as `undefined`. The mapping keys still drive
// `TInternal` inference, so call sites get autocomplete on documented codes
// without giving up runtime resilience to upstream drift.
export const mapEntityStatus = <TInternal extends string>(
  internal: string,
  mapping: Record<TInternal, EntityStatus>,
): EntityStatus =>
  (mapping as Record<string, EntityStatus | undefined>)[internal] ?? {
    type: "unknown",
  };
