/**
 * The fill values one eval run may hand the fill engine.
 *
 * The engine formats in place: `resolveDateFields` writes each row's
 * formatted date back into the row object it read it from, and the composite
 * and formula steps write into `values` the same way. A run that passes the
 * task fixture's own objects therefore leaves the fixture rendered — the next
 * run over the same task submits "October 1, 2026" where an ISO date belongs
 * and is refused. Values reach the engine as a deep copy so a repeat run is a
 * repeat, not a continuation.
 */

export const runFillValues = (
  values: Record<string, unknown>,
): Record<string, unknown> => structuredClone(values);
