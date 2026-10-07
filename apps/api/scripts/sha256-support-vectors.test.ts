import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { compactSchemaDefs } from "./lib/compact-schema-defs";
import { nameAliases } from "./lib/web-api-alias-names";
import { specificationSha256 } from "./provider-request-schemas";
import { selectMatterNames } from "./seed-firm-knowledge.logic";
import { seedId } from "./seed-utils";
import { snapshotDigest } from "./test-db-snapshot-cache";

const TEXT = "Článek\u0000📄\ud800";
const SPECIFICATION_DIGEST =
  "a129f8f6a8c95cbc97ca83d89d609fef6819b58fdf724d4a1d5ee42f10cbd2c7";

test("seed UUIDs and seeded matter order retain their encoded identities", () => {
  const namespace = Bun.env["STELLA_SEED_ID_NAMESPACE"];
  Bun.env["STELLA_SEED_ID_NAMESPACE"] = "sha256-vector";
  try {
    expect(seedId(TEXT)).toBe("a1c136f7-e94c-5612-8435-1735a4433185");
  } finally {
    if (namespace === undefined) {
      delete Bun.env["STELLA_SEED_ID_NAMESPACE"];
    } else {
      Bun.env["STELLA_SEED_ID_NAMESPACE"] = namespace;
    }
  }
  const matterNames = ["a", "ab", "b", TEXT, "a\u0000b", "a"];
  const original = [...matterNames];
  expect(
    selectMatterNames({
      matterCount: 3,
      matterNames,
      selectionSeed: "b\u0000a",
    }),
  ).toEqual(["b", "a\u0000b", TEXT]);
  expect(matterNames).toEqual(original);
});

test("recorded specification digests preserve canonical JSON and Unicode", () => {
  const first = { z: TEXT, a: { y: null, x: [1, false, "a\nb"] } };
  const reordered = { a: { x: [1, false, "a\nb"], y: null }, z: TEXT };
  expect(specificationSha256(first)).toBe(SPECIFICATION_DIGEST);
  expect(specificationSha256(reordered)).toBe(SPECIFICATION_DIGEST);
  expect(specificationSha256({})).toBe(
    "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

test("capability definitions and API aliases retain their published hash names", () => {
  const schema = {
    type: "string",
    enum: Array.from({ length: 40 }, (_, index) => `${TEXT}-${index}`),
  };
  const result = compactSchemaDefs({
    body: { type: "object", properties: { a: schema, b: schema } },
  });
  if (result.status !== "compacted") {
    throw new TypeError("Repeated schema must compact into a named definition");
  }
  expect(Object.keys(result.inputSchema.$defs ?? {})).toEqual([
    "s_0770266c5f0c",
  ]);
  expect([
    ...nameAliases(
      [
        { body: "string", references: 2, recursive: false },
        { body: JSON.stringify(TEXT), references: 2, recursive: false },
      ],
      [
        { from: undefined, to: 0, path: "a" },
        { from: undefined, to: 1, path: "b" },
      ],
    ),
  ]).toEqual([
    [0, "Tca978112ca"],
    [1, "T3e23e81600"],
  ]);
});

test("snapshot streaming retains exact binary digest bytes", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "sha256-snapshot-vector-"),
  );
  const file = path.join(directory, "binary");
  try {
    await writeFile(file, new Uint8Array([255, 0, 1, 128, 13, 10]));
    expect(await snapshotDigest(file)).toBe(
      "797efeb663bbca7577c3673a73054dacd4d5dc852e7d84cc8ab35d79db3268ce",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
