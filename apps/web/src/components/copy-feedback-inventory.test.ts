import { describe, expect, test } from "bun:test";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import { sourceFileIndex } from "@stll/scripts/src/source-file-index";

const REPO_ROOT = path.join(import.meta.dir, "../../../..");
const SOURCE_ROOTS = [
  path.join(REPO_ROOT, "apps/web/src"),
  path.join(REPO_ROOT, "packages"),
];

const ALLOWED = {
  "apps/web/src/components/copy-control.tsx":
    "The one Copy owner confirms by toast only for a Copy in a menu that closes as it copies.",
} as const;

describe("copy feedback ownership", () => {
  test("every copy success toast is an explained baseline", () => {
    const discovered = SOURCE_ROOTS.flatMap((root) => sourceFileIndex(root))
      .filter(
        ({ relativePath, sourceText }) =>
          !/(?:^|\/)(?:node_modules|dist)\//u.test(relativePath) &&
          sourceText.includes("copyToClipboard(") &&
          /stellaToast[\s\S]{0,300}common\.copied|common\.copied[\s\S]{0,300}stellaToast/u.test(
            sourceText,
          ),
      )
      .map(({ filePath }) => repoRelativePath(REPO_ROOT, filePath))
      .toSorted();

    expect(discovered).toEqual(Object.keys(ALLOWED).toSorted());
  });
});
