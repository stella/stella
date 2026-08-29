/**
 * Cluster-legal key construction for every non-queue Valkey key.
 *
 * Valkey runs as a single node today, but the code stays cluster-legal so the
 * migration is a connection-module change (see `/conventions-scale`). Two
 * properties this module owns:
 *
 * 1. Every key carries a `{hashtag}` slot. A cluster routes by the hashtag
 *    alone, so keys that a multi-key command or Lua script touches together
 *    must name the same slot; keys that are only ever read one at a time
 *    should name their own natural unit so the keyspace spreads across the
 *    ring instead of piling onto one node.
 * 2. Every key has a declared expiry. Valkey holds only ephemeral
 *    coordination, so an unbounded key is a decision, recorded in
 *    `COORDINATION_KEY_EXPIRY` with its reason, not an oversight.
 *
 * BullMQ keys are deliberately out of scope: BullMQ owns its own layout under
 * its prefix, and that prefix flips only at the cluster migration behind a
 * queue drain (see `redis-client.ts`).
 */

import { panic } from "better-result";
import * as v from "valibot";

import { FOLIO_COLLAB_REDIS_SCOPE } from "@stll/api-contract/folio-collab";

/**
 * How a scope's keys stop existing. `ttl` means every write sets one, so a
 * flush or a missed cleanup cannot leak the key forever. `unbounded` means the
 * key outlives its writes on purpose and must say why.
 */
export const COORDINATION_KEY_EXPIRY = {
  "api-ratelimit": "ttl",
  "auth-ratelimit": "ttl",
  "mcp-gateway-ratelimit": "ttl",
  "feedback-intake": "ttl",
  // Pub/sub channels do not materialize values. The only stored key under this
  // scope is Hocuspocus's Redlock key, whose lockTimeout supplies its TTL.
  [FOLIO_COLLAB_REDIS_SCOPE]: "ttl",
  "security-canary": "ttl",
  "ocr-readiness": "ttl",
  "workflow-run": "ttl",
  // The OCR repair sweep's resume cursor. A TTL would silently restart the
  // sweep from the beginning of the field table whenever the sweep paused for
  // longer than the window; the key is a single compare-and-set slot, is
  // rewritten on every sweep tick, and losing it costs one redundant pass
  // rather than any correctness.
  "ocr-repair-cursor": "unbounded",
} as const satisfies Record<string, CoordinationKeyExpiry>;

type CoordinationKeyExpiry = "ttl" | "unbounded";

export type CoordinationScope = keyof typeof COORDINATION_KEY_EXPIRY;

const coordinationKeySchema = v.pipe(v.string(), v.brand("CoordinationKey"));

/**
 * A Valkey key built by this module. Command helpers accept only this type, so
 * a hand-assembled string cannot reach a key position.
 */
export type CoordinationKey = v.InferOutput<typeof coordinationKeySchema>;

// Hashtag delimiters are structural: a slot containing one would silently move
// the key to a different slot than the caller named. Percent-escape them (and
// the escape character itself) so distinct inputs stay distinct.
const HASHTAG_DELIMITERS = /[%{}]/u;
const escapeSlot = (slot: string): string =>
  HASHTAG_DELIMITERS.test(slot)
    ? slot.replaceAll("%", "%25").replaceAll("{", "%7B").replaceAll("}", "%7D")
    : slot;

type CoordinationKeyOptions = {
  /** Namespace owning the key; also the ownership boundary for reviews. */
  scope: CoordinationScope;
  /**
   * Colocation unit, emitted as the `{hashtag}`. Keys sharing a slot land on
   * one cluster node and may be touched by one multi-key command or script.
   */
  slot: string;
  /** Optional discriminator between keys within one slot. */
  suffix?: string | undefined;
};

const buildKey = ({ scope, slot, suffix }: CoordinationKeyOptions) => {
  if (slot.length === 0) {
    panic(`Coordination key for scope "${scope}" was built with an empty slot`);
  }
  const base = `${scope}:{${escapeSlot(slot)}}`;
  return v.parse(
    coordinationKeySchema,
    suffix === undefined ? base : `${base}:${suffix}`,
  );
};

/** Build a key in a scope whose every write carries a TTL. */
export const coordinationKey = (
  options: CoordinationKeyOptions,
): CoordinationKey => {
  if (COORDINATION_KEY_EXPIRY[options.scope] === "unbounded") {
    panic(
      `Coordination scope "${options.scope}" is unbounded; use unboundedCoordinationKey`,
    );
  }
  return buildKey(options);
};

/**
 * Build a key in a scope declared `unbounded` above. Separate from
 * `coordinationKey` so an expiry-free key is explicit at its call site rather
 * than an omission the reader has to notice.
 */
export const unboundedCoordinationKey = (
  options: CoordinationKeyOptions,
): CoordinationKey => {
  if (COORDINATION_KEY_EXPIRY[options.scope] !== "unbounded") {
    panic(
      `Coordination scope "${options.scope}" requires a TTL; use coordinationKey`,
    );
  }
  return buildKey(options);
};

type CoordinationTtl = {
  unit: "seconds" | "milliseconds";
  value: number;
};

const ttlArguments = ({ unit, value }: CoordinationTtl): [string, string] => [
  unit === "seconds" ? "EX" : "PX",
  String(value),
];

type CoordinationSetOptions = {
  key: CoordinationKey;
  value: string;
  ttl: CoordinationTtl;
  /** `NX`: only set when the key does not already exist (lock acquisition). */
  onlyIfAbsent?: boolean;
};

/**
 * `SET` arguments for a coordination key. `ttl` is required: a coordination
 * value that outlives its window is a fact living only in Valkey.
 */
export const coordinationSetArguments = ({
  key,
  value,
  ttl,
  onlyIfAbsent = false,
}: CoordinationSetOptions): string[] =>
  onlyIfAbsent
    ? [key, value, ...ttlArguments(ttl), "NX"]
    : [key, value, ...ttlArguments(ttl)];

/** `EXPIRE` arguments; renews a lease without rewriting its value. */
export const coordinationExpireArguments = (
  key: CoordinationKey,
  ttlSeconds: number,
): string[] => [key, String(ttlSeconds)];
