import { expect, test } from "bun:test";

import oxlintConfig from "../../oxlint.config.ts";
import migrationLedger from "../../scripts/sha256-migration-ledger.json" with { type: "json" };
import { SHA256_OWNERS } from "../../scripts/sha256-owners.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const source = [
  'import { createHash as hash, webcrypto as wc } from "node:crypto";',
  'import * as cryptoModule from "node:crypto";',
  'import { CryptoHasher as Hasher, SHA256 as Sha } from "bun";',
  'hash("sha256");',
  'cryptoModule["createHash"]("sha256");',
  'const { createHash: alias } = cryptoModule; alias("sha256");',
  'new Bun.CryptoHasher("sha256");',
  'new Hasher("sha256");',
  'Bun.SHA256.hash("bytes", "hex");',
  "new Sha();",
  'crypto.subtle.digest("SHA-256", bytes);',
  'window.crypto.subtle["digest"]("SHA-256", bytes);',
  'globalThis.crypto.subtle.digest("SHA-256", bytes);',
  'wc.subtle.digest("SHA-256", bytes);',
  'const { digest } = crypto.subtle; digest("SHA-256", bytes);',
  "const H = Bun.CryptoHasher; new H(algorithm);",
  "hash(algorithm);",
].join("\n");

test("confines every supported primitive and immutable alias", async () => {
  expect(await lintSingleRule("no-raw-sha256", source)).toEqual(
    Array.from({ length: 14 }, (_, index) => index + 4),
  );
});

test("admits only the exact runtime owners", async () => {
  expect(Object.keys(SHA256_OWNERS).length).toBeLessThanOrEqual(4);
  for (const owner of Object.keys(SHA256_OWNERS)) {
    expect(
      await lintSingleRule("no-raw-sha256", source, {
        sourcePath: owner,
        cwd: "scratch",
      }),
    ).toEqual([]);
  }
  expect(
    await lintSingleRule("no-raw-sha256", 'new Bun.CryptoHasher("sha256");', {
      sourcePath: "packages/sha256/src/bun.ts.copy.ts",
      cwd: "scratch",
    }),
  ).toEqual([1]);
});

test("preserves other algorithms, keyed HMAC, dynamic CMS and shadowed locals", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'import { createHash } from "node:crypto";',
        'createHash("sha512");',
        '(createHash as typeof createHash)("md5");',
        'new Bun.CryptoHasher("sha256", secret);',
        'const keyed = (undefined: Uint8Array) => new Bun.CryptoHasher("sha256", undefined);',
        'new Bun.CryptoHasher("md5");',
        'crypto.subtle.digest("SHA-1", bytes);',
        "crypto.subtle.digest(hashName, bytes);",
        'const local = (Bun: any, crypto: any) => { new Bun.CryptoHasher("sha256"); crypto.subtle.digest("SHA-256", bytes); };',
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("resolves constant algorithms and default module aliases", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'import nc from "node:crypto";',
        "const { createHash: hash, webcrypto: wc } = nc;",
        'const SHA = "SHA-256"; const alias = SHA;',
        "hash(alias);",
        "wc.subtle.digest(alias, bytes);",
        'nc.createHash("sha256");',
        'nc.webcrypto.subtle.digest("SHA-256", bytes);',
      ].join("\n"),
    ),
  ).toEqual([2, 5, 6, 7]);
});

test("rejects raw values before mutable or interprocedural escape", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'import { createHash } from "node:crypto";',
        'let make = createHash; make = other; make("sha256");',
        "consume(createHash);",
        "const C = Bun.CryptoHasher; invoke(C);",
        "consume(crypto.subtle.digest);",
        "export { createHash };",
        'export { createHash as hash } from "node:crypto";',
        'export { SHA256 } from "bun";',
        'export * from "node:crypto";',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 4, 5, 6, 7, 8, 9]);
});

test("does not pass a raw crypto namespace to another function", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      'import * as nc from "node:crypto"; consume(nc);',
    ),
  ).toEqual([1]);
});

test("confines Bun namespace and default exports including extracted primitives", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'import * as runtime from "bun";',
        'import BunRuntime from "bun";',
        'new runtime.CryptoHasher("sha256");',
        'BunRuntime.SHA256.hash("bytes", "hex");',
        'new BunRuntime.CryptoHasher("sha256");',
        'const { CryptoHasher: C } = BunRuntime; new C("sha256");',
        'const { SHA256: S } = runtime; S.hash("bytes");',
        "consume(BunRuntime.SHA256);",
        'const make = runtime["CryptoHasher"]; invoke(make);',
        'new runtime.CryptoHasher("sha256", secret);',
        'new BunRuntime.CryptoHasher("sha256", secret);',
        'new runtime.CryptoHasher("md5");',
        'new BunRuntime.CryptoHasher("sha512");',
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7, 7, 8, 9, 9]);
});

test("enforces confinement in the repository base configuration", () => {
  expect(oxlintConfig.rules["no-raw-sha256/no-raw-sha256"]).toEqual([
    "error",
    { allowedFiles: migrationLedger.map(({ id }) => id) },
  ]);
});

test("confines WebCrypto SHA-256 algorithm descriptors and immutable aliases", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'crypto.subtle.digest({ name: "SHA-256" }, bytes);',
        'crypto.subtle.digest({ ["name"]: "SHA-256" }, bytes);',
        'const descriptor = { name: "SHA-256" }; const alias = descriptor;',
        "crypto.subtle.digest(alias, bytes);",
        'const name = "SHA-256"; crypto.subtle.digest({ name }, bytes);',
        'crypto.subtle.digest({ name: "SHA-1" }, bytes);',
        "crypto.subtle.digest({ name: hashName }, bytes);",
        "crypto.subtle.digest(hashName, bytes);",
        'crypto.subtle.digest({ name: "SHA-256", ...dynamic }, bytes);',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 4, 5]);
});

test("migration exemptions name exact files while other files remain confined", async () => {
  const migrationSource = 'new Bun.CryptoHasher("sha256");';
  const options = { allowedFiles: ["apps/api/src/migration-example.ts"] };
  expect(
    await lintSingleRule("no-raw-sha256", migrationSource, {
      sourcePath: "apps/api/src/migration-example.ts",
      ruleOptions: options,
      cwd: "scratch",
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule("no-raw-sha256", migrationSource, {
      sourcePath: "apps/api/src/migration-example.ts.copy.ts",
      ruleOptions: options,
      cwd: "scratch",
    }),
  ).toEqual([1]);
  expect(
    await lintSingleRule("no-raw-sha256", migrationSource, {
      sourcePath: "apps/api/src/new-example.ts",
      ruleOptions: options,
      cwd: "scratch",
    }),
  ).toEqual([1]);
});

test("an absent key does not classify a digest as keyed hashing", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      'new Bun.CryptoHasher("sha256", undefined);\nnew Bun.CryptoHasher("sha256", void 0);',
    ),
  ).toEqual([1, 2]);
});

test("owner filenames remain exact within the lint root", async () => {
  expect(
    await lintSingleRule("no-raw-sha256", 'new Bun.CryptoHasher("sha256");', {
      sourcePath: "apps/example/packages/sha256/src/node.ts",
      cwd: "scratch",
    }),
  ).toEqual([1]);
});

test("raw primitives remain confined through indirect invocation", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'import { createHash } from "node:crypto";',
        'createHash.call(null, "sha256");',
        'createHash.apply(null, ["sha256"]);',
        'createHash.bind(null, "sha256");',
        'crypto.subtle.digest.call(crypto.subtle, "SHA-256", bytes);',
        "Bun.SHA256.hash.bind(Bun.SHA256);",
        '(createHash as typeof createHash).call(null, "sha256");',
        'createHash!.bind(null, "sha256");',
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 5, 6, 6, 7, 8]);
});

test("constant absent-key aliases use the digest owner", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        "const key = undefined; const alias = key;",
        'new Bun.CryptoHasher("sha256", alias);',
        'const empty = void 0; new Bun.CryptoHasher("sha256", empty);',
      ].join("\n"),
    ),
  ).toEqual([2, 3]);
});

const cryptoReExports = [
  "const parts = flag ? [safe] : [crypto]; const bag = [...parts]; export const raw = bag[0];",
  "const parts = flag ? [safe] : [crypto]; export const [raw] = [...parts];",
  "const parts = flag ? [safe] : [crypto]; export const [...raw] = [...parts];",
  "const parts = [safe, crypto]; const bag = [...parts]; export const raw = bag[1];",
  "const parts = [safe, crypto]; export const [first, raw] = [...parts];",
  "const parts = [safe, crypto]; export const [first, ...raw] = [...parts];",
  "const bag = { runtime: crypto }; export default bag.runtime.subtle;",
  "const bag = [crypto]; export const raw = bag[0];",
  "const bag = { runtime: crypto }; export default bag.runtime;",
  "const bag = { runtime: Bun }; export const raw = bag.runtime;",
  "const bag = { runtime: crypto }; const alias = bag; export const { runtime } = alias;",
  "export const [api = crypto] = [];",
  "export const [api = crypto] = unknownValues;",
  "export const { nested: { api = crypto } } = { nested: {} };",
  "const runtime = Bun; export const { SHA256: { hash: make } } = runtime;",
  'import * as runtime from "node:crypto"; const { webcrypto: { subtle: api } } = runtime; export { api };',
  "let runtime = Bun; runtime = safe; export const { SHA256 } = runtime;",
  "export const { api } = flag ? { api: crypto } : { api: safe };",
  "export const [api] = flag ? [crypto] : [safe];",
  "export const { api } = fallback || { api: crypto };",

  'import nc from "node:crypto"; export const { webcrypto: { subtle: api } } = nc;',
  "export const [...api] = [crypto];",
  "export const { api = crypto } = {};",

  "export const { ...api } = Bun;",
  "const { randomUUID, ...api } = crypto; export { api };",
  'import * as runtime from "bun"; export const { ...api } = runtime;',
  "export const [api] = [crypto];",
  "const [api] = [crypto]; export { api };",

  'export default await import("node:crypto");',
  'export default require("node:crypto");',
  "export default { subtle: crypto.subtle };",
  "export const api = { crypto };",
  "const api = { crypto }; export { api };",
  "const api = [Bun]; export default api;",
  "let api = globalThis.crypto; api = safe; export { api };",
  "let api; api = globalThis.crypto; export { api };",

  ...["node:crypto", "crypto"].flatMap((module) => [
    `export { webcrypto } from "${module}";`,
    `export { webcrypto as api } from "${module}";`,
    `export { subtle } from "${module}";`,
    `export { default } from "${module}";`,
    `export { default as api } from "${module}";`,
    `export * from "${module}";`,
    `export * as api from "${module}";`,
    `import { webcrypto as api } from "${module}"; export { api };`,
    `import { subtle as api } from "${module}"; export { api };`,
  ]),
  'export { default } from "bun";',
  'export * from "bun";',
  'export * as runtime from "bun";',
  'import * as runtime from "bun"; export { runtime };',
  'import runtime from "bun"; export { runtime };',
  'export { CryptoHasher } from "bun";',
  'export { SHA256 } from "bun";',
  "export default globalThis.crypto;",
  "export default crypto;",
  "export default Bun;",
  "export default crypto.subtle;",
  "const api = globalThis.crypto; export { api };",
  "const { subtle: api } = globalThis.crypto; export { api };",
  "const runtime = Bun; export { runtime };",
  "export const api = globalThis.crypto;",
  "export const runtime = Bun;",
  "export const { subtle: api } = crypto;",
];

test.each(cryptoReExports)(
  "confines crypto-bearing re-exports: %s",
  async (bridge) => {
    const reports = await lintSingleRule("no-raw-sha256", bridge, {
      sourcePath: "apps/example/crypto-bridge.ts",
      cwd: "scratch",
    });
    expect(reports).toEqual([1]);
    for (const owner of Object.keys(SHA256_OWNERS)) {
      expect(
        await lintSingleRule("no-raw-sha256", bridge, {
          sourcePath: owner,
          cwd: "scratch",
        }),
      ).toEqual([]);
    }
  },
);

test("rejects the namespace bridge used by an opaque consumer import", async () => {
  const bridge = 'export { webcrypto } from "node:crypto";';
  const consumer =
    'import { webcrypto } from "./crypto-bridge";\nwebcrypto.subtle.digest("SHA-256", bytes);';
  expect(await lintSingleRule("no-raw-sha256", consumer)).toEqual([]);
  expect(await lintSingleRule("no-raw-sha256", bridge)).toEqual([1]);
});

test("preserves erased re-exports, unrelated exports and shadowed crypto names", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'export type { webcrypto } from "node:crypto";',
        'export { type CryptoHasher } from "bun";',
        'export { serve } from "bun";',

        'export { default } from "./safe-owner";',
        "const crypto = { subtle: { digest: safeDigest } }; export { crypto };",
        "const Bun = { SHA256: safeDigest }; export default Bun;",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("exports noncrypto runtime bindings without exporting their namespace", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      "export const { serve } = Bun;\nexport const { randomUUID } = crypto;\nexport const [first] = [safe, crypto];",
    ),
  ).toEqual([]);
});

test("preserves nested and default noncrypto export bindings", async () => {
  expect(
    await lintSingleRule(
      "no-raw-sha256",
      [
        'export const { options: { mode = "safe" } } = { options: { mode: "safe", crypto } };',
        "const [first, ...rest] = [crypto, safe]; export { rest };",
        "export const { api = safe } = {};",
        "const { crypto: removed, ...remaining } = { crypto, safe }; export { remaining };",
      ].join("\n"),
    ),
  ).toEqual([]);
});
