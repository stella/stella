import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  previewAffected,
  previewPaths,
  VISUAL_PREVIEW_WORKFLOW,
} from "./visual-preview-scope";

const source = readFileSync(VISUAL_PREVIEW_WORKFLOW, "utf-8");
const paths = previewPaths(source);

test("every repository script and action the preview runs is in its path filter", () => {
  // Local paths only: `owner/.github/actions/…@sha` is another repository.
  const referenced = new Set(
    [
      ...source.matchAll(
        /(?:^|[\s"'])(?:\.\/)?((?:scripts|\.github\/actions)\/[\w.-]+(?:\/[\w.-]+)*)/gmu,
      ),
    ].map(([, file]) => file ?? ""),
  );
  expect(referenced.size).toBeGreaterThan(3);
  // A directory (an action, a script folder) is covered when its files are.
  const uncovered = [...referenced].filter((file) => {
    const probe = /\.[a-z]+$/u.test(file) ? file : `${file}/action.yml`;
    return !previewAffected({ changed: [probe], paths });
  });
  expect(uncovered).toEqual([]);
});

test("a merge group runs the preview only for a path of the filter", () => {
  expect(
    previewAffected({
      changed: [".github/actions/setup-playwright/run-in-image.sh"],
      paths,
    }),
  ).toBe(true);
  expect(previewAffected({ changed: ["apps/web/src/main.tsx"], paths })).toBe(
    false,
  );
});

test("the merge-group selection reads the filter instead of a copy", () => {
  expect(source).toContain('bun scripts/visual-preview-scope.ts "$BASE_SHA"');
  expect(source).not.toMatch(/grep -E '\^\(apps\/visual-preview/u);
});
