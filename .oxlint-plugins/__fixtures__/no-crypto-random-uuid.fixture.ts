// Passive regression fixture for
// `no-crypto-random-uuid/no-crypto-random-uuid`.

// MUST flag: named crypto imports expose the wrong UUID version.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: randomUUID imports must use Bun.randomUUIDv7 instead
import { randomUUID as makeRandomUuid } from "node:crypto";

// MUST flag: imported aliases remain traceable at their call site.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: aliased randomUUID calls must be rejected
export const importedUuid = makeRandomUuid();

// MUST flag: the ambient crypto namespace is protected too.
// oxlint-disable-next-line no-crypto-random-uuid/no-crypto-random-uuid -- fixture: ambient crypto.randomUUID must be rejected
export const browserStyleUuid = crypto.randomUUID();

// Allowed: Bun's time-ordered UUID generator is the sanctioned primitive.
export const orderedUuid = Bun.randomUUIDv7();
