import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBundledTemplatePackCatalogue } from "@stll/template-packs";

import { checkBundledPublicTemplates } from "./image-smoke-template-packs";

const roots: string[] = [];
const freshRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "template-image-check-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("image validation requires a configured content root", async () => {
  await expect(checkBundledPublicTemplates(undefined)).rejects.toThrow(
    "TEMPLATE_PACKS_CONTENT_DIR must be set",
  );
});

test.each(["missing", "empty"])(
  "image validation rejects %s content",
  async (state) => {
    const root = freshRoot();
    if (state === "empty") {
      mkdirSync(path.join(root, "packs"));
    }
    await expect(checkBundledPublicTemplates(root)).rejects.toThrow(
      "bundled public template catalogue is incomplete",
    );
  },
);

test("image validation checks the complete public pack and its bytes", async () => {
  const root = freshRoot();
  const source = path.resolve(
    import.meta.dir,
    "../../../../../packages/template-packs/content/packs/general-legal",
  );
  cpSync(source, path.join(root, "packs", "general-legal"), {
    recursive: true,
  });
  await checkBundledPublicTemplates(root);
  const template =
    createBundledTemplatePackCatalogue(root)
      .get("general-legal")
      ?.templates.at(0) ?? panic("expected populated public pack");
  const file = path.join(root, "packs", "general-legal", template.file);
  writeFileSync(file, "invalid content");
  await expect(checkBundledPublicTemplates(root)).rejects.toThrow(
    "Bundled template bytes do not match the manifest hash",
  );
  rmSync(file);
  await expect(checkBundledPublicTemplates(root)).rejects.toThrow(
    "bundled public template catalogue is incomplete",
  );
});
