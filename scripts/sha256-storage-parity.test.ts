import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { createSha256 } from "@stll/sha256/bun";
import { createSha256 as createLegacyNodeHash } from "@stll/sha256/node";

import { hashSwallowedItemTokens } from "../.oxlint-plugins/no-swallowed-item-error";
import { findDuplicateRasterAssets } from "./check-duplicate-raster-assets";
import { watchedPathsHashAtHead } from "./check-marketing-recordings";
import { hashBytes } from "./check-migration-order";
import { checkMigrationIndexBuilds } from "./check-migration-safety";
import { usCourtPartitionOf } from "./generate-us-courts";
import { hashGeneratedSource } from "./generated-source-hash";
import {
  hashProductMediaFile,
  hashProductRecordingArtifacts,
  recordingArtifactPaths,
  updateRecordingArtifactDigest,
} from "./product-media";

for (const text of ["", "ordinary", "Žluťoučký kůň Łódź 📄", "e\u0301"]) {
  test(`migration, generated source and lint ledger identities retain legacy bytes: ${JSON.stringify(text)}`, () => {
    const bytes = new TextEncoder().encode(text);
    const expected = createLegacyNodeHash().update(bytes).digest("hex");
    expect(hashBytes(bytes)).toBe(expected);
    expect(hashGeneratedSource(text)).toBe(expected);
    expect(hashGeneratedSource(bytes)).toBe(expected);
    const tokens = ["try", "{", JSON.stringify(text), "}", "catch", "{}"];
    expect(hashSwallowedItemTokens(tokens)).toBe(
      createLegacyNodeHash().update(JSON.stringify(tokens)).digest("hex"),
    );
    const digest = createLegacyNodeHash().update(`USA:${text}`).digest();
    expect(
      usCourtPartitionOf(text) ===
        `p${String((digest.at(0) ?? 0) % 16).padStart(2, "0")}`,
    ).toBe(true);
  });

  test(`migration acknowledgements pin exact raw statement bytes: ${JSON.stringify(text)}`, () => {
    const raw = `CREATE INDEX "${text || "empty"}" ON case_law_decisions (id)`;
    const source = `${raw};`;
    const findings = checkMigrationIndexBuilds([
      { file: "migration.sql", source },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings.at(0)?.statementHash).toBe(
      createLegacyNodeHash().update(raw).digest("hex"),
    );
  });

  test(`media and duplicate raster identities retain stored bytes: ${JSON.stringify(text)}`, async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), "sha256-media-parity-"));
    const bytes = new TextEncoder().encode(text);
    try {
      await writeFile(nodePath.join(root, "a.png"), bytes);
      await writeFile(nodePath.join(root, "b.png"), bytes);
      const expected = createLegacyNodeHash().update(bytes).digest("hex");
      expect(await hashProductMediaFile(nodePath.join(root, "a.png"))).toBe(
        expected,
      );
      const groups = await findDuplicateRasterAssets({
        rootDir: root,
        files: ["b.png", "a.png"],
      });
      expect(groups).toHaveLength(1);
      expect(groups.at(0)).toMatchObject({
        digest: expected,
        size: bytes.length,
        paths: ["a.png", "b.png"],
      });
      const captureId = "parity";
      const paths = recordingArtifactPaths(captureId, "light");
      const legacy = createLegacyNodeHash();
      const current = createSha256();
      for (const path of paths) {
        const framedPath = `apps/landing/public/${path}`;
        await writeFile(nodePath.join(root, nodePath.basename(path)), bytes);
        legacy.update(`${framedPath}\0`).update(bytes);
        updateRecordingArtifactDigest({
          hasher: current,
          path: framedPath,
          bytes,
        });
      }
      const framedDigest = legacy.digest("hex");
      expect(current.digest("hex")).toBe(framedDigest);
      expect(
        await hashProductRecordingArtifacts(root, captureId, "light"),
      ).toBe(framedDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const paths of [
  ["package.json", "README.md"],
  ["e\u0301", "Článek"],
]) {
  test(`recording source identities retain JSON/newline/git tree framing: ${JSON.stringify(paths)}`, () => {
    const normalized = [...new Set(paths)].toSorted();
    const tree = execFileSync(
      "git",
      ["ls-tree", "-r", "--full-tree", "HEAD", "--", ...normalized],
      { cwd: nodePath.resolve(import.meta.dir, ".."), encoding: "utf-8" },
    ).trim();
    expect(watchedPathsHashAtHead(paths)).toBe(
      createLegacyNodeHash()
        .update(`${JSON.stringify(normalized)}\n${tree}\n`)
        .digest("hex"),
    );
  });
}
