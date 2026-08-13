// Passive regression fixture for
// `no-ambient-nondeterminism/no-ambient-nondeterminism`.

import { randomUUID, randomUUID as nodeRandomUuid } from "node:crypto";

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient epoch time must be injected
export const epoch = Date.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism, unicorn/new-for-builtins -- fixture: direct Date calls are part of the rejected API surface
export const dateString = Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism, unicorn/new-for-builtins -- fixture: Date ignores arguments when called without new
export const dateStringWithIgnoredArgument = Date(0);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: implicit current date must be injected
export const instant = new Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient pseudo-randomness must be injected
export const sample = Math.random();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient UUID generation must be injected
export const identifier = crypto.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient entropy must be injected
export const randomBytes = crypto.getRandomValues(new Uint8Array(8));

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: UUIDv7 includes ambient time and entropy
export const sortableIdentifier = Bun.randomUUIDv7();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient monotonic time must be injected
export const monotonicTime = performance.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: imported ambient UUID generation must be injected
export const importedIdentifier = randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: aliased imports retain their provenance
export const aliasedImportedIdentifier = nodeRandomUuid();

const readNow = Date.now;
const createSortableIdentifier = Bun.randomUUIDv7;
const createImportedIdentifier = randomUUID;
const { now: destructuredDateNow } = Date;
/* oxlint-disable typescript/unbound-method -- fixture: destructured global methods are the rejected API surface */
const { random: destructuredMathRandom } = Math;
const {
  getRandomValues: destructuredGetRandomValues,
  randomUUID: destructuredRandomUuid,
} = crypto;
const {
  Date: { now: nestedGlobalDateNow },
  Math: { random: nestedGlobalMathRandom },
  crypto: {
    getRandomValues: nestedGlobalGetRandomValues,
    randomUUID: nestedGlobalRandomUuid,
  },
} = globalThis;
/* oxlint-enable typescript/unbound-method */

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: stable aliases retain ambient provenance
export const aliasedEpoch = readNow();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: stable global-member aliases retain ambient provenance
export const aliasedSortableIdentifier = createSortableIdentifier();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: stable imported aliases retain ambient provenance
export const twiceAliasedImportedIdentifier = createImportedIdentifier();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: destructuring cannot erase Date.now provenance
export const destructuredEpoch = destructuredDateNow();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: destructuring cannot erase Math.random provenance
export const destructuredSample = destructuredMathRandom();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: destructuring cannot erase crypto.randomUUID provenance
export const destructuredIdentifier = destructuredRandomUuid();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: destructuring cannot erase crypto.getRandomValues provenance
export const destructuredRandomBytes = destructuredGetRandomValues(
  new Uint8Array(8),
);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested globalThis destructuring retains Date.now provenance
export const nestedDestructuredEpoch = nestedGlobalDateNow();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested globalThis destructuring retains Math.random provenance
export const nestedDestructuredSample = nestedGlobalMathRandom();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested globalThis destructuring retains crypto.randomUUID provenance
export const nestedDestructuredIdentifier = nestedGlobalRandomUuid();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested globalThis destructuring retains crypto.getRandomValues provenance
export const nestedDestructuredRandomBytes = nestedGlobalGetRandomValues(
  new Uint8Array(8),
);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access is still ambient time
export const globalEpoch = globalThis.Date.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism, unicorn/new-for-builtins -- fixture: explicit globalThis calls are part of the rejected API surface
export const globalDateString = globalThis.Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism, unicorn/new-for-builtins -- fixture: globalThis.Date also ignores call arguments
export const globalDateStringWithIgnoredArgument = globalThis.Date(0);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis construction is still ambient time
export const globalInstant = new globalThis.Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access is still ambient randomness
export const globalSample = globalThis.Math.random();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access is still ambient UUID generation
export const globalIdentifier = globalThis.crypto.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access remains ambient entropy
export const globalRandomBytes = globalThis.crypto.getRandomValues(
  new Uint8Array(8),
);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access remains ambient time and entropy
export const globalSortableIdentifier = globalThis.Bun.randomUUIDv7();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access remains ambient monotonic time
export const globalMonotonicTime = globalThis.performance.now();

const ambientRoot = globalThis;
const secondAmbientRoot = ambientRoot;
/* oxlint-disable typescript/unbound-method -- fixture: nested global method aliases are the rejected API surface */
const {
  Date: { now: nestedAliasedRootNow },
} = ambientRoot;
/* oxlint-enable typescript/unbound-method */

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: a stable globalThis alias cannot hide Date.now
export const rootAliasedEpoch = ambientRoot.Date.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: a stable globalThis alias cannot hide implicit date construction
export const rootAliasedInstant = new ambientRoot.Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: chained globalThis aliases retain Math provenance
export const chainedRootSample = secondAmbientRoot.Math.random();

export const chainedRootIdentifier =
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: chained globalThis aliases retain crypto provenance
  secondAmbientRoot.crypto.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested destructuring follows an immutable globalThis alias
export const nestedAliasedRootEpoch = nestedAliasedRootNow();

export const explicitDate = new Date("2026-08-13T00:00:00.000Z");

const DateConstructor = Date;

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: constructor aliases retain ambient provenance
export const aliasedInstant = new DateConstructor();

export const withShadowedBindings = (
  Date: { (): string; now: () => number; new (): object },
  Math: { random: () => number },
  Bun: { randomUUIDv7: () => string },
  crypto: {
    getRandomValues: (value: Uint8Array) => Uint8Array;
    randomUUID: () => string;
  },
  performance: { now: () => number },
  // oxlint-disable-next-line no-shadow-restricted-names -- fixture: a shadowed globalThis binding must remain allowed
  globalThis: {
    Date: { (): string; now: () => number; new (): object };
    Math: { random: () => number };
    Bun: { randomUUIDv7: () => string };
    crypto: {
      getRandomValues: (value: Uint8Array) => Uint8Array;
      randomUUID: () => string;
    };
    performance: { now: () => number };
  },
) => ({
  epoch: Date.now(),
  // oxlint-disable-next-line unicorn/new-for-builtins -- fixture: the shadowed callable is deliberately not the Date built-in
  dateString: Date(),
  // oxlint-disable-next-line unicorn/new-for-builtins -- fixture: the shadowed callable accepts arguments unlike the Date built-in
  dateStringWithArgument: Date(0),
  instant: new Date(),
  sample: Math.random(),
  sortableIdentifier: Bun.randomUUIDv7(),
  identifier: crypto.randomUUID(),
  randomBytes: crypto.getRandomValues(new Uint8Array(8)),
  monotonicTime: performance.now(),
  globalEpoch: globalThis.Date.now(),
  // oxlint-disable-next-line unicorn/new-for-builtins -- fixture: the shadowed callable is deliberately not the Date built-in
  globalDateString: globalThis.Date(),
  // oxlint-disable-next-line unicorn/new-for-builtins -- fixture: the shadowed callable accepts arguments unlike the Date built-in
  globalDateStringWithArgument: globalThis.Date(0),
  globalInstant: new globalThis.Date(),
  globalSample: globalThis.Math.random(),
  globalSortableIdentifier: globalThis.Bun.randomUUIDv7(),
  globalIdentifier: globalThis.crypto.randomUUID(),
  globalRandomBytes: globalThis.crypto.getRandomValues(new Uint8Array(8)),
  globalMonotonicTime: globalThis.performance.now(),
});

export const withShadowedAliases = (
  Date: { now: () => number },
  Math: { random: () => number },
  crypto: {
    getRandomValues: (value: Uint8Array) => Uint8Array;
    randomUUID: () => string;
  },
  // oxlint-disable-next-line no-shadow-restricted-names -- fixture: aliases of a shadowed globalThis binding must remain allowed
  globalThis: {
    Date: { now: () => number; new (): object };
    Math: { random: () => number };
    crypto: { randomUUID: () => string };
  },
) => {
  const { now: localNow } = Date;
  const { random: localRandom } = Math;
  const {
    getRandomValues: localGetRandomValues,
    randomUUID: localRandomUuid,
  } = crypto;
  const {
    Date: { now: nestedLocalNow },
    Math: { random: nestedLocalRandom },
    crypto: { randomUUID: nestedLocalRandomUuid },
  } = globalThis;
  const localRoot = globalThis;
  return {
    epoch: localNow(),
    sample: localRandom(),
    identifier: localRandomUuid(),
    randomBytes: localGetRandomValues(new Uint8Array(8)),
    rootEpoch: localRoot.Date.now(),
    rootInstant: new localRoot.Date(),
    rootSample: localRoot.Math.random(),
    rootIdentifier: localRoot.crypto.randomUUID(),
    nestedEpoch: nestedLocalNow(),
    nestedSample: nestedLocalRandom(),
    nestedIdentifier: nestedLocalRandomUuid(),
  };
};

let mutableReadNow = Date.now;
export const mutableAliasReference = mutableReadNow;
mutableReadNow = () => 0;
export const mutableAliasResult = mutableReadNow();

let mutableRoot = globalThis;
export const mutableRootReference = mutableRoot;
mutableRoot = {
  ...globalThis,
  Date: class extends Date {
    static override now = () => 0;
  },
};
/* oxlint-disable typescript/unbound-method -- fixture: a mutable-root nested alias must remain allowed by the custom rule */
const {
  Date: { now: mutableNestedNow },
} = mutableRoot;
/* oxlint-enable typescript/unbound-method */
export const mutableRootResult = mutableRoot.Date.now();
export const mutableNestedResult = mutableNestedNow();
