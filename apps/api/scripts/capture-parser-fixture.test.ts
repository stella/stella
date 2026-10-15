import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex as nodeSha256Hex } from "@stll/sha256/node";

import { hashAdapterFixtureBytes } from "../src/handlers/case-law/ingestion/adapters/update-fixtures";
import {
  CAPTURED_FIXTURE_ROOTS,
  provenancePathOf,
} from "../src/tests/fixture-provenance";
import { captureParserFixture } from "./capture-parser-fixture";
import { hashRecordedFixtureBytes } from "./record-eu-ecj-fixtures";

for (const content of [
  "",
  "ordinary",
  "Článek\u0000📄",
  "Příliš žluťoučký kůň",
  "e\u0301",
]) {
  for (const compression of ["plain", "gzip"] as const) {
    test(`captured sidecar pins exact stored bytes against Node SHA: ${compression} ${JSON.stringify(content)}`, async () => {
      const apiRoot = mkdtempSync(
        path.join(tmpdir(), "parser-capture-parity-"),
      );
      const served = new TextEncoder().encode(content);
      const name = compression === "gzip" ? "capture.html.gz" : "capture.html";
      const dir = CAPTURED_FIXTURE_ROOTS.at(0);
      expect(dir).toBeDefined();
      if (dir === undefined) {
        throw new TypeError("At least one captured root must exist");
      }
      const relative = path.join(dir, name);
      mkdirSync(path.dirname(path.join(apiRoot, relative)), {
        recursive: true,
      });
      try {
        await captureParserFixture({
          apiRoot,
          argv: [
            "https://fixture.example/decision",
            "--name",
            name,
            "--dir",
            dir,
            ...(compression === "gzip" ? ["--gzip"] : []),
          ],
          fetchPage: async () => new Response(served, { status: 200 }),
        });
        const stored = await Bun.file(path.join(apiRoot, relative)).bytes();
        expect(hashRecordedFixtureBytes(stored)).toBe(nodeSha256Hex(stored));
        expect(hashAdapterFixtureBytes(stored)).toBe(nodeSha256Hex(stored));
        expect(
          compression === "gzip" ? Bun.gunzipSync(stored) : stored,
        ).toEqual(served);
        const sidecar: unknown = await Bun.file(
          path.join(apiRoot, provenancePathOf(relative)),
        ).json();
        expect(sidecar).toMatchObject({
          capture: "recorded",
          sha256: nodeSha256Hex(stored),
          sourceUrl: "https://fixture.example/decision",
        });
      } finally {
        rmSync(apiRoot, { recursive: true, force: true });
      }
    });
  }
}
