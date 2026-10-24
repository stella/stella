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

test("checks static JSX expression attributes through rendered ancestors", async () => {
  expect(
    await lintSingleRule(
      "no-rendered-error-translation",
      `const alert = <p role={"alert"}><span>{t("errors.actionFailed")}</span></p>;
const destructive = <p className={"text-destructive text-sm"}><b>{t("readerAnswers.networkError")}</b></p>;
const template = <p role={\`alert\`}><span>{t("readerAnswers.modelError")}</span></p>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2, 3]);
});

test("does not treat an event handler translation as rendered alert content", async () => {
  expect(
    await lintSingleRule(
      "no-rendered-error-translation",
      `const view = <p role="alert"><button onClick={() => notifyUserError(error, t("errors.actionFailed"))}>Retry</button></p>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
