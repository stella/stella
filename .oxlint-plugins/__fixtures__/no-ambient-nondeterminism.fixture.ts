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

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: stable aliases retain ambient provenance
export const aliasedEpoch = readNow();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: stable global-member aliases retain ambient provenance
export const aliasedSortableIdentifier = createSortableIdentifier();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: stable imported aliases retain ambient provenance
export const twiceAliasedImportedIdentifier = createImportedIdentifier();

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
