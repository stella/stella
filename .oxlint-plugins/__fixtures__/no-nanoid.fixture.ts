// Passive regression fixture for `no-nanoid/no-nanoid`.

// oxlint-disable-next-line no-nanoid/no-nanoid -- fixture proves a side-effect import cannot reintroduce the removed dependency
import "nanoid";

const generatedId = Bun.randomUUIDv7();
const randomBytes = crypto.getRandomValues(new Uint8Array(16));

export { generatedId, randomBytes };
