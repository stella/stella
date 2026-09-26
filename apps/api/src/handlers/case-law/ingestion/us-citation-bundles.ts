/**
 * Which printed references name one decision.
 *
 * A bundle is one printing of a decision: a full reference and the parallel
 * references beside it. Bundles sharing an identifier are the same decision
 * cited again, so they merge into one entity, and every entity holds each
 * distinct identifier once. Merging is online, so an antecedent lookup made
 * mid-document sees the entities as they stand, and the identity bound is
 * enforced as identifiers join, before any oversized target exists.
 *
 * An entity asserting two first pages in one reporter, or printed under two
 * different case captions, is a conflicting equivalence: it names no single
 * decision, and every reference into it abstains.
 */

import { panic, Result, TaggedError } from "better-result";

import { DECISION_IDENTIFIER_MAX_COUNT } from "@stll/legal-ast/decision-identifier";

import type { ReporterBase } from "@/api/handlers/case-law/ingestion/us-citation-scanner";

/** Distinct identifiers one cited decision may carry. */
export const US_CITATION_BUNDLE_LIMIT = DECISION_IDENTIFIER_MAX_COUNT;

export class UsCitationBundleOverflowError extends TaggedError(
  "UsCitationBundleOverflowError",
)<{
  message: string;
  limit: number;
}> {}

type Entity = {
  bases: ReporterBase[];
  /** Reporter family to the one key the entity holds in it. */
  families: Map<string, string>;
  caption: string | null;
  conflicting: boolean;
};

export type EntityTarget =
  | { status: "identified"; bases: readonly [ReporterBase, ...ReporterBase[]] }
  | { status: "conflicting" };

const EDITION_RANK: Readonly<Record<string, number>> = {
  "U.S.": 0,
  "S. Ct.": 1,
  "L. Ed.": 2,
  "L. Ed. 2d": 2,
};
const OTHER_EDITION_RANK = 3;

const compareCodeUnits = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** Storage order: U.S., then S. Ct., then L. Ed., then the rest by spelling. */
const compareBases = (left: ReporterBase, right: ReporterBase): number =>
  (EDITION_RANK[left.edition] ?? OTHER_EDITION_RANK) -
    (EDITION_RANK[right.edition] ?? OTHER_EDITION_RANK) ||
  compareCodeUnits(left.identifier.value, right.identifier.value);

const overflow = (): UsCitationBundleOverflowError =>
  new UsCitationBundleOverflowError({
    message: `A cited decision exceeds ${String(US_CITATION_BUNDLE_LIMIT)} identifiers`,
    limit: US_CITATION_BUNDLE_LIMIT,
  });

/** Adds one new identifier to an entity, noting a second page in a family. */
const holdBase = (entity: Entity, base: ReporterBase): void => {
  entity.bases.push(base);
  const held = entity.families.get(base.family);
  if (held === undefined) {
    entity.families.set(base.family, base.key);
  } else if (held !== base.key) {
    entity.conflicting = true;
  }
};

export type BundleGraph = {
  /** Opens a bundle for a full reference printed under `caption`. */
  open: (
    base: ReporterBase,
    caption: string | null,
  ) => Result<number, UsCitationBundleOverflowError>;
  /** Adds a parallel reference to an open bundle. */
  join: (
    bundle: number,
    base: ReporterBase,
  ) => Result<void, UsCitationBundleOverflowError>;
  /** The reporter families printed in this bundle itself. */
  hasFamily: (bundle: number, family: string) => boolean;
  /** The entity a bundle belongs to now; stable only until the next merge. */
  root: (bundle: number) => number;
  /** What the bundle's entity names, read once every bundle is in. */
  target: (bundle: number) => EntityTarget;
};

export const createBundleGraph = (): BundleGraph => {
  const parent: number[] = [];
  const families: Set<string>[] = [];
  const entities = new Map<number, Entity>();
  const holders = new Map<string, number>();
  const sorted = new Map<number, EntityTarget>();

  const root = (bundle: number): number => {
    let at = bundle;
    for (let up = parent[at]; up !== undefined && up !== at; up = parent[at]) {
      at = up;
    }
    // Path compression keeps later lookups near constant.
    for (let node = bundle; node !== at;) {
      const up = parent[node] ?? at;
      parent[node] = at;
      node = up;
    }
    return at;
  };

  const entityOf = (bundle: number): Entity => {
    const entity = entities.get(root(bundle));
    if (entity === undefined) {
      return panic(`Bundle ${String(bundle)} has no entity`);
    }
    return entity;
  };

  /**
   * Merges two entities, the smaller into the larger so each identifier
   * moves O(log n) times; a tie keeps the earlier entity as the root, so a
   * repeated citation lands in the entity antecedents were filed under.
   */
  const merge = (
    earlier: number,
    later: number,
  ): Result<void, UsCitationBundleOverflowError> => {
    const first = root(earlier);
    const second = root(later);
    if (first === second) {
      return Result.ok(undefined);
    }
    const firstEntity = entityOf(first);
    const secondEntity = entityOf(second);
    if (
      firstEntity.bases.length + secondEntity.bases.length >
      US_CITATION_BUNDLE_LIMIT
    ) {
      return Result.err(overflow());
    }
    const [keep, fold] =
      secondEntity.bases.length > firstEntity.bases.length
        ? [second, first]
        : [first, second];
    const kept = entityOf(keep);
    const folded = entityOf(fold);
    for (const base of folded.bases) {
      holdBase(kept, base);
    }
    kept.conflicting ||=
      folded.conflicting ||
      (kept.caption !== null &&
        folded.caption !== null &&
        kept.caption !== folded.caption);
    kept.caption ??= folded.caption;
    parent[fold] = keep;
    entities.delete(fold);
    sorted.clear();
    return Result.ok(undefined);
  };

  /** Adds `base` to the bundle's entity, merging with any entity holding it. */
  const attach = (
    bundle: number,
    base: ReporterBase,
  ): Result<void, UsCitationBundleOverflowError> => {
    families[bundle]?.add(base.family);
    const holder = holders.get(base.key);
    if (holder !== undefined) {
      return merge(holder, bundle);
    }
    const entity = entityOf(bundle);
    if (entity.bases.length >= US_CITATION_BUNDLE_LIMIT) {
      return Result.err(overflow());
    }
    holders.set(base.key, bundle);
    holdBase(entity, base);
    sorted.clear();
    return Result.ok(undefined);
  };

  return {
    open: (base, caption) => {
      const bundle = parent.length;
      parent.push(bundle);
      families.push(new Set());
      entities.set(bundle, {
        bases: [],
        families: new Map(),
        caption,
        conflicting: false,
      });
      return attach(bundle, base).map(() => bundle);
    },
    join: (bundle, base) => attach(bundle, base),
    hasFamily: (bundle, family) => families[bundle]?.has(family) ?? false,
    root,
    target: (bundle) => {
      const at = root(bundle);
      const cached = sorted.get(at);
      if (cached !== undefined) {
        return cached;
      }
      const entity = entityOf(at);
      const [first, ...rest] = entity.bases.toSorted(compareBases);
      const target: EntityTarget =
        entity.conflicting || first === undefined
          ? { status: "conflicting" }
          : { status: "identified", bases: [first, ...rest] };
      sorted.set(at, target);
      return target;
    },
  };
};
