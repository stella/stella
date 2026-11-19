import type { ProvisionHistoryItem } from "@/features/statutes/queries/provision-history";

/** How a consolidation's wording relates to the one just before it. */
export type ProvisionWordingChange = Extract<
  ProvisionHistoryItem,
  { status: "found" }
>["wordingChange"];

/** Where a run of one wording starts, as the history says it started. */
export type WordingRunStart = Exclude<ProvisionWordingChange, "unchanged">;

type WordingItem = { documentId: string } & (
  | { status: "found"; wordingChange: ProvisionWordingChange }
  | { status: "unavailable" }
);

/**
 * One wording of the provision over consecutive consolidations, newest
 * first. `start` is how its oldest member relates to the version before it;
 * null while that member's older neighbour has not been read yet, so the
 * run may reach further back than what is listed.
 */
export type WordingRun<T> = {
  members: T[];
  start: WordingRunStart | null;
};

/**
 * Whether a run's start is established: the version before its oldest member
 * was read and could be compared. Otherwise the wording may reach further
 * back than the oldest version listed.
 */
export const isRunStartKnown = (start: WordingRunStart | null): boolean =>
  start !== null && start !== "unknown";

export type WordingRunGroup<T> =
  ({ type: "run" } & WordingRun<T>) | { type: "unavailable"; item: T };

/**
 * A newest-first history folded into runs of one wording. Two neighbours
 * share a run exactly when the newer one says its wording is `unchanged`:
 * the server compares each wording with the consolidation just before it,
 * the version after a page's end included, so a run reads the same however
 * the history was paged. A version without readable text stands alone.
 */
export const groupWordingRuns = <T extends WordingItem>(
  items: readonly T[],
): WordingRunGroup<T>[] => {
  const groups: WordingRunGroup<T>[] = [];
  let open: ({ type: "run" } & WordingRun<T>) | null = null;
  for (const item of items) {
    if (item.status === "unavailable") {
      open = null;
      groups.push({ type: "unavailable", item });
      continue;
    }
    if (open === null) {
      open = { type: "run", members: [], start: null };
      groups.push(open);
    }
    open.members.push(item);
    if (item.wordingChange === "unchanged") {
      continue;
    }
    open.start = item.wordingChange;
    open = null;
  }
  return groups;
};

type ActVersion = { id: string };

/**
 * One row of the act's version list read for a provision, newest first:
 *
 * - `run`: consecutive versions with one wording of the provision.
 * - `absent`: consecutive versions that do not carry the provision.
 * - `unavailable`: a version whose text could not be read; it is never
 *   counted into a run on either side.
 * - `unread`: a version past the end of what the history read covered.
 */
export type ProvisionVersionRow<V> =
  | ({ type: "run" } & WordingRun<V>)
  | { type: "absent"; members: V[] }
  | { type: "unavailable"; version: V }
  | { type: "unread"; version: V };

type BuildRowsOptions<V> = {
  history: { complete: boolean; items: readonly WordingItem[] };
  /** Every version of the act, newest first, as the version list orders it. */
  versions: readonly V[];
};

/**
 * The act's versions grouped by the provision's wording. The history lists
 * only versions that carry the provision, in the version list's own order,
 * so a version it leaves out does not carry it; past the last version a
 * bounded read reached, that is no longer known and the version is listed
 * on its own.
 */
export const buildProvisionVersionRows = <V extends ActVersion>({
  history,
  versions,
}: BuildRowsOptions<V>): ProvisionVersionRow<V>[] => {
  const groups = groupWordingRuns(history.items);
  const groupOf = new Map<string, WordingRunGroup<WordingItem>>();
  for (const group of groups) {
    const members = group.type === "run" ? group.members : [group.item];
    for (const member of members) {
      groupOf.set(member.documentId, group);
    }
  }
  const covered = history.complete
    ? versions.length
    : versions.findLastIndex((version) => groupOf.has(version.id)) + 1;
  const rows: ProvisionVersionRow<V>[] = [];
  // The history group the last row lists, so its next member joins it.
  let lastGroup: WordingRunGroup<WordingItem> | null = null;

  for (const [index, version] of versions.entries()) {
    const group = groupOf.get(version.id);
    const last = rows.at(-1);
    if (group === undefined) {
      lastGroup = null;
      if (index >= covered) {
        rows.push({ type: "unread", version });
      } else if (last?.type === "absent") {
        last.members.push(version);
      } else {
        rows.push({ type: "absent", members: [version] });
      }
      continue;
    }
    if (group.type === "unavailable") {
      lastGroup = group;
      rows.push({ type: "unavailable", version });
      continue;
    }
    if (group === lastGroup && last?.type === "run") {
      last.members.push(version);
      continue;
    }
    lastGroup = group;
    rows.push({ type: "run", members: [version], start: group.start });
  }
  return rows;
};

/**
 * The version just before a run's oldest member: what the provision said
 * before this wording, when the run started with a change.
 */
export const previousWordingVersion = <V extends ActVersion>(
  run: WordingRun<V>,
  versions: readonly V[],
): V | null => {
  const oldest = run.members.at(-1);
  if (run.start !== "changed" || oldest === undefined) {
    return null;
  }
  const index = versions.findIndex((version) => version.id === oldest.id);
  return index === -1 ? null : (versions.at(index + 1) ?? null);
};

type DatedVersion = ActVersion & {
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

/**
 * The window a run of one wording covers. A version not yet in force that
 * keeps the wording does not end the window; it is named apart (`alsoFrom`),
 * because the wording holds now and will still hold then. A run made only of
 * versions not yet in force is a coming change, dated by the day it takes
 * effect.
 */
export type RunWindow =
  | { type: "future"; from: string | null }
  | {
      type: "window";
      from: string | null;
      to: string | null;
      /** Versions in force now or before, which the window spans. */
      count: number;
      /** The first day of the earliest version not yet in force, if any. */
      alsoFrom: string | null;
    };

export const runWindow = <V extends DatedVersion>(
  members: readonly V[],
  isFuture: (version: V) => boolean,
): RunWindow => {
  const oldest = members.at(-1);
  const past = members.filter((member) => !isFuture(member));
  const future = members.filter(isFuture);
  if (past.length === 0) {
    return { type: "future", from: oldest?.versionValidFrom ?? null };
  }
  return {
    type: "window",
    from: oldest?.versionValidFrom ?? null,
    // The wording outlives the newest version in force when a later one
    // keeps it, so the window ends with the newest member, open or not,
    // rather than the day before that later version.
    to: (future.at(0) ?? past.at(0))?.versionValidTo ?? null,
    count: past.length,
    alsoFrom: future.at(-1)?.versionValidFrom ?? null,
  };
};

/**
 * The version a row opens: the one on screen when the row holds it, else the
 * version in force, else the newest one that took effect, else the newest.
 */
export const runOpenTarget = <V extends ActVersion>(
  members: readonly V[],
  {
    inForceId,
    isFuture,
    selectedId,
  }: {
    inForceId: string | null;
    isFuture: (version: V) => boolean;
    selectedId: string;
  },
): V | undefined =>
  members.find((member) => member.id === selectedId) ??
  members.find((member) => member.id === inForceId) ??
  members.find((member) => !isFuture(member)) ??
  members.at(0);
