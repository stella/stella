// Passive regression fixture for
// `no-crypto-random-uuid/no-crypto-random-uuid`.

// MUST flag: named crypto imports expose the wrong UUID version.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: randomUUID imports must use the runtime owner instead
import { randomUUID as makeRandomUuid } from "node:crypto";
// MUST flag: UUID package generators belong behind the runtime owner.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: direct v4 and v7 imports must be rejected
import { v4, v7 as makeUuidV7 } from "uuid";

// MUST flag: imported aliases remain traceable at their call site.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: aliased randomUUID calls must be rejected
export const importedUuid = makeRandomUuid();

// MUST flag: the ambient crypto namespace is protected too.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: ambient crypto.randomUUID must be rejected
export const browserStyleUuid = crypto.randomUUID();

// MUST flag: an explicit globalThis receiver cannot bypass the owner.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: globalThis crypto calls must use the runtime UUIDv7 owner
export const globalBrowserStyleUuid = globalThis.crypto.randomUUID();

export const directV4Uuid = v4();
export const directV7Uuid = makeUuidV7();

// Allowed: Bun's time-ordered UUID generator is the sanctioned primitive.
// expect-clean: no-crypto-random-uuid/no-crypto-random-uuid
export const orderedUuid = Bun.randomUUIDv7();

// Allowed: application code uses the web owner for identifiers and nonces.
// expect-clean: no-crypto-random-uuid/no-crypto-random-uuid
export { createRandomValue, createUuid } from "../../apps/web/src/lib/uuid";
