/**
 * Binds a member tuple to its named-constant map.
 *
 * The tuple is the declaration; the map is a naming convenience over it. The
 * mapping is total (every member needs a key) and exact (a key cannot point at
 * a different member, and an unknown key is rejected), so a member added,
 * removed, or misrouted in either form fails typecheck instead of leaving one
 * copy behind — which for a persisted enum means a value the column accepts and
 * the CHECK constraint rejects.
 *
 *   const POLARITIES = ["positive", "unknown"] as const;
 *   type Polarity = (typeof POLARITIES)[number];
 *   const POLARITY = {
 *     POSITIVE: "positive",
 *     UNKNOWN: "unknown",
 *   } as const satisfies ConstantMap<Polarity>;
 */
export type ConstantMap<T extends string> = { [K in T as ConstantName<K>]: K };

/** `llm-proposed` -> `LLM_PROPOSED`: the key a hyphenated member is named by. */
type ConstantName<S extends string> = S extends `${infer Head}-${infer Rest}`
  ? `${Uppercase<Head>}_${ConstantName<Rest>}`
  : Uppercase<S>;
