import { CryptoHasher as Hasher, SHA256 } from "bun";
import { createHash, createHash as hash, webcrypto as wc } from "node:crypto";
import * as cryptoModule from "node:crypto";

const bytes = new Uint8Array();
const algorithm = process.env.HASH_ALGORITHM;
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves destructured acquisition is confined
const { createHash: alias } = cryptoModule;
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves destructured digest acquisition is confined
const { digest } = crypto.subtle;
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
createHash("sha256");
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
hash("sha256");
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
cryptoModule["createHash"]("sha256");
// expect-clean: no-raw-sha256/no-raw-sha256
alias("sha256");
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
new Bun.CryptoHasher("sha256");
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
new Hasher("sha256");
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
Bun.SHA256.hash("bytes", "hex");
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
new SHA256();
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
crypto.subtle.digest("SHA-256", bytes);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
window.crypto.subtle.digest("SHA-256", bytes);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
globalThis.crypto.subtle["digest"]("SHA-256", bytes);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
wc.subtle.digest("SHA-256", bytes);
// expect-clean: no-raw-sha256/no-raw-sha256
digest("SHA-256", bytes);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
createHash(algorithm);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw hashing is confined
new Bun.CryptoHasher(algorithm);
// expect-clean: no-raw-sha256/no-raw-sha256
createHash("sha512");
// expect-clean: no-raw-sha256/no-raw-sha256
new Bun.CryptoHasher("sha256", "key");
// expect-clean: no-raw-sha256/no-raw-sha256
new Bun.CryptoHasher("md5");
// expect-clean: no-raw-sha256/no-raw-sha256
crypto.subtle.digest("SHA-1", bytes);
// expect-clean: no-raw-sha256/no-raw-sha256
crypto.subtle.digest(algorithm, bytes);

// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw primitive values cannot escape
let make = createHash;
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw primitive values cannot escape
consume(createHash);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw primitive values cannot escape
const C = Bun.CryptoHasher;
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw primitive values cannot escape
consume(crypto.subtle.digest);
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw primitive values cannot escape
export { createHash };
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves raw primitive values cannot escape
export { SHA256 } from "bun";
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves wildcard exports expose the primitive
export * from "node:crypto";
// oxlint-disable-next-line no-raw-sha256/no-raw-sha256 -- fixture proves namespace values cannot carry the primitive
consume(cryptoModule);
