import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { createSha256, sha256Hex as nodeSha256Hex } from "@stll/sha256/node";
import { stableStringify } from "@stll/stable-stringify";

import {
  nativeImageSourceRevision,
  runNativeImageProbes,
} from "./ai-native-image-canary";
import { createCassetteFetch } from "./ai-provider-cassette";
import { buildApiTestCommand } from "./api-test-command";
import { compactSchemaDefs } from "./lib/compact-schema-defs";
import { nameAliases } from "./lib/web-api-alias-names";
import { specificationSha256 } from "./provider-request-schemas";
import { selectMatterNames } from "./seed-firm-knowledge.logic";
import { seedFileIdentity, seedId, seedMemberId } from "./seed-utils";
import { snapshotDigest, snapshotKey } from "./test-db-snapshot-cache";

const TEXT_INPUTS = [
  "",
  "ordinary",
  "Článek\u0000📄",
  "Příliš žluťoučký kůň",
  "e\u0301",
  "\ud800",
];

for (const text of TEXT_INPUTS) {
  test(`seed identities preserve Node hash bytes and UUID layout: ${JSON.stringify(text)}`, () => {
    const previousNamespace = Bun.env["STELLA_SEED_ID_NAMESPACE"];
    const previousOrgId = Bun.env["STELLA_SEED_ORG_ID"];
    try {
      delete Bun.env["STELLA_SEED_ORG_ID"];
      for (const namespace of ["", "parita-Článek"]) {
        Bun.env["STELLA_SEED_ID_NAMESPACE"] = namespace;
        const hex = nodeSha256Hex(
          namespace ? `${namespace}:${text}` : text,
        ).slice(0, 32);
        const raw = `${hex.slice(0, 12)}5${hex.slice(13, 16)}8${hex.slice(17)}`;
        expect(seedId(text)).toBe(
          `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`,
        );
      }
    } finally {
      if (previousNamespace === undefined) {
        delete Bun.env["STELLA_SEED_ID_NAMESPACE"];
      } else {
        Bun.env["STELLA_SEED_ID_NAMESPACE"] = previousNamespace;
      }
      if (previousOrgId === undefined) {
        delete Bun.env["STELLA_SEED_ORG_ID"];
      } else {
        Bun.env["STELLA_SEED_ORG_ID"] = previousOrgId;
      }
    }
  });

  test(`seeded selections preserve NUL framing and rank order: ${JSON.stringify(text)}`, () => {
    const names = ["a", "ab", "b", "Článek", "a\u0000b", "a"];
    const expected = [...new Set(names)]
      .map((name) => ({
        name,
        rank: createSha256()
          .update(text)
          .update("\0")
          .update(name)
          .digest("hex"),
      }))
      .toSorted(
        (a, b) =>
          compareCodeUnit(a.rank, b.rank) || compareCodeUnit(a.name, b.name),
      )
      .slice(0, 3)
      .map(({ name }) => name);
    expect(
      selectMatterNames({
        matterCount: 3,
        matterNames: names,
        selectionSeed: text,
      }),
    ).toEqual(expected);
  });

  test(`specification and compacted schema names preserve canonical digest bytes: ${JSON.stringify(text)}`, () => {
    const specification = { z: text, a: { y: null, x: [1, false, text] } };
    const canonical = JSON.stringify({
      a: { x: [1, false, text], y: null },
      z: text,
    });
    expect(specificationSha256(specification)).toBe(nodeSha256Hex(canonical));
    expect(specificationSha256({})).toBe(nodeSha256Hex("{}"));
    const schema = {
      type: "string",
      enum: Array.from({ length: 40 }, (_, index) => `${text}-${index}`),
    };
    const compacted = compactSchemaDefs({
      body: { type: "object", properties: { a: schema, b: schema } },
    });
    expect(compacted.status).toBe("compacted");
    if (compacted.status !== "compacted") {
      throw new TypeError("Repeated schema must compact");
    }
    expect(Object.keys(compacted.inputSchema.$defs ?? {})).toEqual([
      `s_${nodeSha256Hex(JSON.stringify(schema)).slice(0, 12)}`,
    ]);
  });

  test(`alias names preserve path and structural hash composition: ${JSON.stringify(text)}`, () => {
    const firstBody = JSON.stringify(text);
    const secondBody = JSON.stringify(`${text}x`);
    const names = nameAliases(
      [
        { body: firstBody, references: 2, recursive: false },
        { body: secondBody, references: 2, recursive: false },
      ],
      [
        { from: undefined, to: 0, path: "same" },
        { from: undefined, to: 1, path: "same" },
      ],
    );
    expect([...names]).toEqual([
      [
        0,
        `T${nodeSha256Hex(`same\u0000${nodeSha256Hex(firstBody)}`).slice(0, 10)}`,
      ],
      [
        1,
        `T${nodeSha256Hex(`same\u0000${nodeSha256Hex(secondBody)}`).slice(0, 10)}`,
      ],
    ]);
  });

  test(`recorded cassette body identities preserve stable JSON hash bytes: ${JSON.stringify(text)}`, async () => {
    const body = { z: text, a: [null, "Článek", ""] };
    const transport = createCassetteFetch({
      mode: "record",
      apiKey: "fixture-secret",
      maxRequests: 1,
      permittedOrigins: ["https://provider.example"],
      recordedAt: () => "2026-09-14T12:00:00.000Z",
      upstreamFetch: async () =>
        new Response(JSON.stringify({ output: "ok" }), {
          headers: { "content-type": "application/json" },
        }),
    });
    await transport.fetch(
      new Request("https://provider.example/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const cassette = await transport.finish();
    expect(cassette.entries.at(0)?.request.bodySha256).toBe(
      nodeSha256Hex(stableStringify(body)),
    );
  });
}

test("snapshot stream, dependency framing and timing filenames preserve Node digest bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sha256-support-parity-"));
  try {
    const source = 'export const title = "Článek";';
    const lock = "lock-Článek\u0000";
    const entry = path.join(root, "entry.ts");
    writeFileSync(entry, source);
    writeFileSync(path.join(root, "bun.lock"), lock);
    const expectedKey = createSha256()
      .update("1")
      .update("\0")
      .update(Bun.version)
      .update("\0")
      .update("bun.lock")
      .update("\0")
      .update(lock)
      .update("\0")
      .update("entry.ts")
      .update("\0")
      .update(source)
      .digest("hex");
    expect(snapshotKey(root, entry)).toBe(expectedKey);
    for (const bytes of [
      ...TEXT_INPUTS.map((text) => new TextEncoder().encode(text)),
      new Uint8Array([255, 0, 1, 128, 13, 10]),
    ]) {
      const file = path.join(root, "binary");
      writeFileSync(file, bytes);
      expect(await snapshotDigest(file)).toBe(
        nodeSha256Hex(readFileSync(file)),
      );
    }
    const testFiles = ["Článek.test.ts", "empty.test.ts"];
    const command = buildApiTestCommand({
      bunExecutable: "bun",
      bunRuntimeArguments: [],
      testArguments: [],
      testFiles,
      timingsDirectory: root,
    });
    const timingArgument = command.find((argument) =>
      argument.startsWith("--timings="),
    );
    expect(
      timingArgument?.endsWith(
        `-${nodeSha256Hex(JSON.stringify(testFiles))}.json`,
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const text of TEXT_INPUTS) {
  test(`seed member identities preserve framing and truncation: ${JSON.stringify(text)}`, () => {
    for (const organizationId of TEXT_INPUTS) {
      expect(seedMemberId({ organizationId, userId: text })).toBe(
        `seed-member-${nodeSha256Hex(`${organizationId}:${text}`).slice(0, 24)}`,
      );
    }
  });
}

for (const bytes of [
  ...TEXT_INPUTS.map((text) => new TextEncoder().encode(text)),
  new Uint8Array([255, 0, 1, 128, 13, 10]),
  new Uint8Array([7, 255, 0, 128, 9]).subarray(1, 4),
]) {
  test(`seed file metadata and image source provenance pin the original byte range: ${JSON.stringify([...bytes])}`, async () => {
    expect(seedFileIdentity(bytes)).toEqual({
      sizeBytes: bytes.byteLength,
      sha256Hex: nodeSha256Hex(bytes),
    });
    expect(nativeImageSourceRevision("  revision-Článek\n", bytes)).toBe(
      `revision-Článek:${nodeSha256Hex(bytes)}`,
    );
    const sourceRevision = nativeImageSourceRevision("a".repeat(40), bytes);
    const records = await runNativeImageProbes({
      apiKey: "synthetic-test-key",
      provider: "google",
      modelIds: ["synthetic-model"],
      adapterVersion: "synthetic-adapter@1.0.0",
      sourceRevision,
      bytes,
      now: () => Date.UTC(2026, 8, 6),
      runProbe: async () => ({ attempts: 1, status: "passed" }),
    });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.fixtureSha256).toBe(nodeSha256Hex(bytes));
      expect(record.sourceRevision).toBe(
        `${"a".repeat(40)}:${nodeSha256Hex(bytes)}`,
      );
    }
  });
}
