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

test("checks inline map and flatMap values that flow into alert children", async () => {
  expect(
    await lintSingleRule(
      "no-rendered-error-translation",
      `const map = <p role="alert">{items.map(() => t("errors.actionFailed"))}</p>;
const flatMap = <p role="alert">{items.flatMap(function () { return [t("readerAnswers.networkError")]; })}</p>;
const conditional = <p role="alert">{ready && items["map"](() => t("errors.actionFailed"))}</p>;
const children = <p role="alert" children={items.map(() => t("errors.actionFailed"))} />;
const nested = <p role="alert">{items.map(() => <span>{t("errors.actionFailed")}</span>)}</p>;
const returning = <p role="alert">{items.map(() => { if (ready) { return t("errors.actionFailed"); } return "fine"; })}</p>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("keeps event handlers, discarded projections and opaque callbacks outside rendered text", async () => {
  expect(
    await lintSingleRule(
      "no-rendered-error-translation",
      `const handler = <p role="alert"><button onClick={() => items.map(() => t("errors.actionFailed"))}>Retry</button></p>;
const eventAttribute = <p role="alert" onClick={items.map(() => t("errors.actionFailed"))} />;
const opaque = <p role="alert">{notify(items.map(() => t("errors.actionFailed")))}</p>;
const count = <p role="alert">{items.map(() => t("errors.actionFailed")).length}</p>;
const filter = <p role="alert">{items.filter(() => t("errors.actionFailed"))}</p>;
const computed = <p role="alert">{items[map](() => t("errors.actionFailed"))}</p>;
const discardedCall = <p role="alert">{items.map(() => { notify(t("errors.actionFailed")); return "fine"; })}</p>;
const discardedStatement = <p role="alert">{items.flatMap(() => { t("errors.actionFailed"); return ["fine"]; })}</p>;`,
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});
