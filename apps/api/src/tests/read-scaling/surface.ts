import { panic } from "better-result";
import * as v from "valibot";

const LedgerEntrySchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  reason: v.pipe(v.string(), v.trim(), v.minLength(12)),
});
const ScalingLedgerSchema = v.object({
  unmeasuredReads: v.array(LedgerEntrySchema),
  pendingWriteHarness: v.array(LedgerEntrySchema),
});

/** Membership comes from the mounted router, including prefixes and plugins. */
export const apiScalingSurface = (
  routes: readonly { method: string; path: string }[],
) => {
  const routesById = new Map(
    routes
      .filter(({ path }) => path === "/v1" || path.startsWith("/v1/"))
      .map(({ method, path }) => [`${method} ${path}`, method]),
  );
  return {
    reads: [...routesById]
      .filter(([, method]) => method === "GET")
      .map(([id]) => id)
      .toSorted(),
    writes: [...routesById]
      .filter(([, method]) => !["GET", "HEAD", "OPTIONS"].includes(method))
      .map(([id]) => id)
      .toSorted(),
  };
};

/** Annotations classify the curated registry; names do not imply read semantics. */
export const mcpScalingSurface = (
  tools: readonly { name: string; annotations: { readOnlyHint: boolean } }[],
) => ({
  reads: tools
    .filter(({ annotations }) => annotations.readOnlyHint)
    .map(({ name }) => name)
    .toSorted(),
  writes: tools
    .filter(({ annotations }) => !annotations.readOnlyHint)
    .map(({ name }) => name)
    .toSorted(),
});

type ScalingCoverageOptions = {
  surface: readonly string[];
  measured: readonly string[];
  exemptions: readonly { id: string; reason: string }[];
};
export const scalingCoverageViolations = ({
  surface,
  measured,
  exemptions,
}: ScalingCoverageOptions) => {
  const existing = new Set(surface);
  const measuredIds = new Set(measured);
  const exemptIds = new Set(exemptions.map(({ id }) => id));
  return [
    ...surface
      .filter((id) => !measuredIds.has(id) && !exemptIds.has(id))
      .map((id) => `unmeasured: ${id}`),
    ...measured
      .filter((id) => !existing.has(id))
      .map((id) => `stale scenario: ${id}`),
    ...exemptions.flatMap(({ id, reason }) => [
      ...(!existing.has(id) ? [`stale exemption: ${id}`] : []),
      ...(measuredIds.has(id) ? [`remove measured exemption: ${id}`] : []),
      ...(reason.trim().length < 12 ? [`exemption needs a reason: ${id}`] : []),
    ]),
    ...(exemptIds.size !== exemptions.length ? ["duplicate exemptions"] : []),
    ...(measuredIds.size !== measured.length ? ["duplicate scenarios"] : []),
  ];
};

/** Prefix the sections so moving an entry cannot renew its allowance. */
export const parseScalingLedger = (text: string, label: string): string[] => {
  const parsed = v.safeParse(ScalingLedgerSchema, JSON.parse(text));
  if (!parsed.success) {
    return panic(
      `${label} must contain reasoned read and write ledger sections`,
    );
  }
  return Object.entries(parsed.output).flatMap(([section, entries]) =>
    entries.map(({ id }) => `${section}:${id}`),
  );
};

type NewWriteRouteAllowanceOptions = {
  /** The ledger entries on the base, section-prefixed. */
  base: readonly string[];
  /** The ledger entries in this change, section-prefixed. */
  current: readonly string[];
  /** The mounted non-GET routes in this change. */
  writes: readonly string[];
};

/**
 * Base entries plus the write routes this change adds to the pending write
 * harness. While no write is measured the census holds every base write route
 * in that section, so a pending entry the base lacks that names a mounted
 * write route is a route this change adds; it may enter with its reason.
 * Read exemptions and existing entries stay shrink-only.
 */
export const withNewWriteRoutes = ({
  base,
  current,
  writes,
}: NewWriteRouteAllowanceOptions): string[] => {
  const known = new Set(base);
  const pendingWrites = new Set(
    writes.map((id) => `pendingWriteHarness:${id}`),
  );
  return [
    ...base,
    ...current.filter((entry) => !known.has(entry) && pendingWrites.has(entry)),
  ];
};
