// Passive regression fixture for
// `no-ambient-nondeterminism/no-ambient-nondeterminism`.

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient epoch time must be injected
export const epoch = Date.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism, unicorn/new-for-builtins -- fixture: direct Date calls are part of the rejected API surface
export const dateString = Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: implicit current date must be injected
export const instant = new Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient pseudo-randomness must be injected
export const sample = Math.random();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: ambient UUID generation must be injected
export const identifier = crypto.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access is still ambient time
export const globalEpoch = globalThis.Date.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism, unicorn/new-for-builtins -- fixture: explicit globalThis calls are part of the rejected API surface
export const globalDateString = globalThis.Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis construction is still ambient time
export const globalInstant = new globalThis.Date();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access is still ambient randomness
export const globalSample = globalThis.Math.random();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: explicit globalThis access is still ambient UUID generation
export const globalIdentifier = globalThis.crypto.randomUUID();

export const explicitDate = new Date("2026-08-13T00:00:00.000Z");

export const withShadowedBindings = (
  Date: { (): string; now: () => number; new (): object },
  Math: { random: () => number },
  crypto: { randomUUID: () => string },
  // oxlint-disable-next-line no-shadow-restricted-names -- fixture: a shadowed globalThis binding must remain allowed
  globalThis: {
    Date: { (): string; now: () => number; new (): object };
    Math: { random: () => number };
    crypto: { randomUUID: () => string };
  },
) => ({
  epoch: Date.now(),
  // oxlint-disable-next-line unicorn/new-for-builtins -- fixture: the shadowed callable is deliberately not the Date built-in
  dateString: Date(),
  instant: new Date(),
  sample: Math.random(),
  identifier: crypto.randomUUID(),
  globalEpoch: globalThis.Date.now(),
  // oxlint-disable-next-line unicorn/new-for-builtins -- fixture: the shadowed callable is deliberately not the Date built-in
  globalDateString: globalThis.Date(),
  globalInstant: new globalThis.Date(),
  globalSample: globalThis.Math.random(),
  globalIdentifier: globalThis.crypto.randomUUID(),
});
