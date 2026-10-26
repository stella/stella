import { compareCodeUnit } from "@stll/collation";
import { filterBySearchQuery } from "@stll/text-normalize";
import { Temporal } from "@stll/time";

type SiblingCandidate = {
  client: { id: string } | null;
  id: string;
  /** ISO 8601 instant, as the matter list serializes it. */
  lastActivityAt: string;
};

type SelectSiblingMattersOptions<TMatter extends SiblingCandidate> = {
  /** The current matter's client; null for a personal matter. */
  clientId: string | null;
  matters: readonly TMatter[];
};

/**
 * The matters the breadcrumb switcher offers: every matter in the list under
 * the current matter's client, or every personal matter when it has none. The
 * current matter stays in the result so the switcher can mark it. Most recent
 * activity leads, as on the matter list, because the matter people switch to
 * is usually one they were just working in; ties fall back to the id so the
 * order never depends on the list's.
 */
export const selectSiblingMatters = <TMatter extends SiblingCandidate>({
  clientId,
  matters,
}: SelectSiblingMattersOptions<TMatter>): TMatter[] =>
  matters
    .filter((matter) => (matter.client?.id ?? null) === clientId)
    .toSorted(
      (a, b) =>
        Temporal.Instant.compare(b.lastActivityAt, a.lastActivityAt) ||
        compareCodeUnit(a.id, b.id),
    );

type SearchableMatter = {
  name: string;
  /** The reference as shown; null when it is hidden or absent. */
  reference: string | null;
};

/**
 * Matters whose name or shown reference contains the query, accent- and
 * case-insensitively, in their given order. A blank query keeps every matter.
 */
export const filterMattersByQuery = <TMatter extends SearchableMatter>(
  matters: readonly TMatter[],
  query: string,
): readonly TMatter[] =>
  filterBySearchQuery({
    items: matters,
    query,
    fields: ({ name, reference }) => [name, reference],
  });
