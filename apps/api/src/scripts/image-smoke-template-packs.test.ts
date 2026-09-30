import { panic, Result } from "better-result";
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTemplatePackCatalogue } from "@stll/template-packs";
import {
  fixtureTemplatePackContentRoot,
  FIXTURE_TEMPLATE_PACKS,
} from "@stll/template-packs/fixtures";
import type { GeneratedTemplatePack } from "@stll/template-packs/schema";

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

const expectValidationFailure = async (
  validate: () => Promise<void>,
  message: string,
) => {
  const result = await Result.tryPromise(validate);
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error.message).toContain(message);
  }
};

test("image validation requires a configured content root", async () => {
  await expectValidationFailure(
    () => checkBundledPublicTemplates(undefined),
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
    await expectValidationFailure(
      () => checkBundledPublicTemplates(root),
      "bundled public template catalogue is incomplete",
    );
  },
);

test("image validation checks the complete public pack and its bytes", async () => {
  const root = freshRoot();
  const fixturePack = FIXTURE_TEMPLATE_PACKS.at(0);
  if (!fixturePack) {
    panic("expected populated fixture pack");
  }
  const source = path.join(
    fixtureTemplatePackContentRoot(),
    "packs",
    fixturePack.id,
  );
  cpSync(source, path.join(root, "packs", "general-legal"), {
    recursive: true,
  });
  const publicFixture = {
    ...fixturePack,
    id: "general-legal",
    publicDisplay: true,
  } satisfies GeneratedTemplatePack;
  const catalogueFactory = (contentRoot: string) =>
    createTemplatePackCatalogue({ packs: [publicFixture], contentRoot });
  await checkBundledPublicTemplates(root, catalogueFactory);
  const template =
    fixturePack.templates.at(0) ?? panic("expected populated fixture template");
  const file = path.join(root, "packs", publicFixture.id, template.file);
  writeFileSync(file, "invalid content");
  await expectValidationFailure(
    () => checkBundledPublicTemplates(root, catalogueFactory),
    "Bundled template bytes do not match the manifest hash",
  );
  rmSync(file);
  await expectValidationFailure(
    () => checkBundledPublicTemplates(root, catalogueFactory),
    "bundled public template catalogue is incomplete",
  );
});
