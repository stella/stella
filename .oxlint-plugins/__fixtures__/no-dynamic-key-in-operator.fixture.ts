// Passive regression fixture for
// `no-dynamic-key-in-operator/no-dynamic-key-in-operator`.

declare const eventType: string;
declare const streamPolicies: Record<string, "read" | "ignore">;

// oxlint-disable-next-line no-dynamic-key-in-operator/no-dynamic-key-in-operator -- fixture proves a wire-derived event type is flagged
export const hasStreamPolicy = eventType in streamPolicies;

// expect-clean: no-dynamic-key-in-operator/no-dynamic-key-in-operator
export const acceptedChecks = (part: object, candidate: object) => [
  "type" in part,
  0 in part,
  `status` in part,
  Brand.is(candidate),
];

class Brand {
  readonly #value = true;

  static is(candidate: object): boolean {
    return #value in candidate;
  }

  read(): boolean {
    return this.#value;
  }
}
