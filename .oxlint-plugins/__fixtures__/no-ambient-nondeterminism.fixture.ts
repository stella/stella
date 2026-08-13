// Passive regression fixture for
// `no-ambient-nondeterminism/no-ambient-nondeterminism`.

/* oxlint-disable unicorn/prefer-node-protocol -- fixture: every supported bare crypto import form must retain provenance */
import bareCryptoDefault, {
  randomUUID as bareRandomUuid,
  webcrypto as bareWebcrypto,
} from "crypto";
import * as bareCryptoNamespace from "crypto";
/* oxlint-enable unicorn/prefer-node-protocol */
import nodeCryptoDefault, {
  randomUUID,
  randomUUID as nodeRandomUuid,
  webcrypto as nodeWebcrypto,
} from "node:crypto";
import * as nodeCryptoNamespace from "node:crypto";

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

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: bare crypto named imports retain ambient provenance
export const bareImportedIdentifier = bareRandomUuid();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: node:crypto namespace imports retain ambient provenance
export const nodeNamespaceIdentifier = nodeCryptoNamespace.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: bare crypto namespace imports retain ambient provenance
export const bareNamespaceIdentifier = bareCryptoNamespace.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: node:crypto default imports retain ambient provenance
export const nodeDefaultIdentifier = nodeCryptoDefault.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: bare crypto default imports retain ambient provenance
export const bareDefaultIdentifier = bareCryptoDefault.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: named node:crypto webcrypto imports retain randomUUID provenance
export const nodeWebcryptoIdentifier = nodeWebcrypto.randomUUID();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: named bare crypto webcrypto imports retain getRandomValues provenance
export const bareWebcryptoBytes = bareWebcrypto.getRandomValues(
  new Uint8Array(8),
);

export const nodeNamespaceWebcryptoIdentifier =
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: node:crypto namespace webcrypto retains randomUUID provenance
  nodeCryptoNamespace.webcrypto.randomUUID();

export const bareDefaultWebcryptoBytes =
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: bare crypto default webcrypto retains getRandomValues provenance
  bareCryptoDefault.webcrypto.getRandomValues(new Uint8Array(8));

export const bareNamespaceWebcryptoBytes =
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: bare crypto namespace webcrypto retains getRandomValues provenance
  bareCryptoNamespace.webcrypto.getRandomValues(new Uint8Array(8));

export const nodeDefaultWebcryptoIdentifier =
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: node:crypto default webcrypto retains randomUUID provenance
  nodeCryptoDefault.webcrypto.randomUUID();

/* oxlint-disable typescript/unbound-method -- fixture: destructured imported webcrypto methods are the rejected API surface */
const {
  webcrypto: { randomUUID: destructuredNodeWebcryptoRandomUuid },
} = nodeCryptoNamespace;
/* oxlint-enable typescript/unbound-method */

export const destructuredNodeWebcryptoIdentifier =
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested destructuring retains imported webcrypto provenance
  destructuredNodeWebcryptoRandomUuid();

const localCryptoModule = { randomUUID: () => "local" };
const localCryptoModuleAlias = localCryptoModule;
const { randomUUID: localCryptoRandomUuid } = localCryptoModule;

export const localModuleIdentifier = localCryptoModule.randomUUID();
export const localAliasedModuleIdentifier =
  localCryptoModuleAlias.randomUUID();
export const localDestructuredIdentifier = localCryptoRandomUuid();

const localWebcryptoModule = {
  webcrypto: {
    getRandomValues: (value: Uint8Array) => value,
    randomUUID: () => "local",
  },
};
export const localWebcryptoIdentifier =
  localWebcryptoModule.webcrypto.randomUUID();

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

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: Node's global alias is the same ambient host as globalThis
export const nodeGlobalEpoch = global.Date.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: Node's global alias preserves nested crypto provenance
export const nodeGlobalIdentifier = global.crypto.randomUUID();

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

const directClock = { now: Date.now };
const spreadClock = { ...directClock };
const nestedServices = { clock: spreadClock };
const overriddenClock = { ...directClock, now: () => 0 };
const localClock = { now: () => 0 };
const spreadLocalClock = { ...localClock };

export const withOpaqueClockOverride = (override: { now: () => number }) => {
  const opaqueClock = { now: Date.now, ...override };
  return opaqueClock.now();
};

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: a static object property retains ambient function provenance
export const objectPropertyEpoch = directClock.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: an immutable object spread retains ambient function provenance
export const spreadObjectEpoch = spreadClock.now();

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: nested static object properties retain ambient provenance
export const nestedObjectEpoch = nestedServices.clock.now();

export const overriddenSpreadEpoch = overriddenClock.now();
export const localObjectEpoch = spreadLocalClock.now();

// Mere storage does not execute ambient nondeterminism.
export const storedAmbientFunction = Date.now;

const callbackValues = [1, 2] as const;

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: Array callbacks execute ambient functions
export const callbackEpochs = [1, 2].map(Date.now);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: immutable aliases of array literals remain provable built-ins
export const aliasedArrayCallbackEpochs = callbackValues.map(Date.now);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: passing Date itself to a callback executes ambient current-time reads
export const callbackDateStrings = [1, 2].map(Date);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: Array.from's mapper executes ambient functions
export const callbackArrayFromEpochs = Array.from([1, 2], Date.now);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: timer callbacks execute ambient function aliases
export const ambientTimer = setTimeout(directClock.now, 0);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: imported ambient functions retain provenance in callback positions
export const importedAmbientTimer = setTimeout(randomUUID, 0);

const localCallback = () => 0;
export const localCallbackValues = [1, 2].map(localCallback);

const ambientLocalCallback = () =>
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: locally declared callback bodies are visited at their ambient call
  Date.now();
export const ambientLocalCallbackValues = [1, 2].map(ambientLocalCallback);

const customCallbackStore = {
  map: (callback: typeof Date.now) => callback,
};
export const customMethodStoredCallback = customCallbackStore.map(Date.now);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: native Promise executors invoke ambient function references
export const ambientPromiseExecutor = new Promise(Date.now);

// oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: native Promise callbacks execute ambient function references
export const ambientPromiseCallback = Promise.resolve(0).then(Date.now);

export const ambientPromiseCallbacks = Promise.resolve(0).then(
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: native Promise fulfillment callbacks execute ambient function references
  Date.now,
  // oxlint-disable-next-line no-ambient-nondeterminism/no-ambient-nondeterminism -- fixture: native Promise rejection callbacks execute ambient function references
  randomUUID,
);

const customThenableStore = {
  then: (callback: typeof Date.now) => callback,
};
export const customThenableStoredCallback =
  customThenableStore.then(Date.now);

export const withShadowedPromise = (
  // oxlint-disable-next-line no-shadow-restricted-names -- fixture: a local Promise constructor must not be treated as the global built-in
  Promise: new (callback: typeof Date.now) => object,
) => new Promise(Date.now);

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
  callbackEpochs: [1, 2].map(Date.now),
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

export const withShadowedNodeGlobal = (
  global: {
    Date: { now: () => number };
    crypto: { randomUUID: () => string };
  },
) => ({ epoch: global.Date.now(), identifier: global.crypto.randomUUID() });

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
