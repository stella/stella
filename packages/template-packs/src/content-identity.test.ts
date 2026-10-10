import { Result } from "better-result";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Hex as nodeSha256Hex } from "@stll/sha256/node";

import { createTemplatePackCatalogue } from "./catalogue";
import { templatePackContentIdentity } from "./content-identity";
import { FIXTURE_TEMPLATE_PACKS } from "./fixtures/catalogue";

for (const bytes of [
  ...[
    "",
    "plain text",
    "Příliš žluťoučký kůň",
    "e\u0301",
    "Článek\u0000📄",
  ].map((text) => new TextEncoder().encode(text)),
  new Uint8Array([255, 0, 128, 13, 10]),
  new Uint8Array([7, 255, 0, 128, 9]).subarray(1, 4),
]) {
  test(`template manifest identities and runtime reads preserve Node byte digests: ${JSON.stringify([...bytes])}`, async () => {
    const pack = FIXTURE_TEMPLATE_PACKS.at(0);
    const template = pack?.templates.at(0);
    expect(template).toBeDefined();
    if (pack === undefined || template === undefined) {
      throw new TypeError("Template fixture must exist");
    }
    const contentRoot = mkdtempSync(
      path.join(tmpdir(), "template-identity-parity-"),
    );
    try {
      const sha256 = nodeSha256Hex(bytes);
      expect(templatePackContentIdentity(bytes)).toEqual({ sha256 });
      const file = path.join(contentRoot, "packs", pack.id, template.file);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      const catalogue = createTemplatePackCatalogue({
        packs: [{ ...pack, templates: [{ ...template, sha256 }] }],
        contentRoot,
      });
      const read = await catalogue.readTemplateDocx({
        packId: pack.id,
        slug: template.slug,
      });
      expect(Result.isError(read)).toBe(false);
      if (Result.isError(read)) {
        throw read.error;
      }
      expect(read.value.bytes).toEqual(bytes);
      expect(read.value.sha256).toBe(sha256);
    } finally {
      rmSync(contentRoot, { recursive: true, force: true });
    }
  });
}
