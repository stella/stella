import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects alert and destructive elements that render error translations", async () => {
  expect(
    await lintSingleRule(
      "no-rendered-error-translation",
      `const alert = <p role="alert">{t("errors.actionFailed")}</p>;
const destructive = <span className="text-destructive text-sm">{t("readerAnswers.networkError")}</span>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2]);
});

test("accepts progress text and non-error destructive treatments", async () => {
  expect(
    await lintSingleRule(
      "no-rendered-error-translation",
      `const progress = <p role="status">{t("readerAnswers.loading")}</p>;
const treatment = <span className="text-destructive">{t("caseLaw.negativeTreatment")}</span>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
