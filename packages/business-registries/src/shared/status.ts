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

export const mapEntityStatus = <TInternal extends string>(
  internal: TInternal,
  mapping: Record<TInternal, EntityStatus>,
): EntityStatus => mapping[internal];
