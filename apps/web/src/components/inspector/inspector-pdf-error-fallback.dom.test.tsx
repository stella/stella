import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ConversionRefusalFallback } =
  await import("./inspector-pdf-error-fallback");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const mount = (
  refusal:
    | { kind: "unsupported_field"; fieldType: string }
    | {
        kind: "unsupported_reference";
        format: "text/html";
        element: string;
        attribute: string;
      }
    | { kind: "legacy_format"; replacementExtension: ".xlsx" | ".pptx" },
) => {
  render(
    <IntlProvider locale="en" messages={messages}>
      <ConversionRefusalFallback refusal={refusal} />
    </IntlProvider>,
  );
};

test("shows the named document field conversion refusal", () => {
  mount({ kind: "unsupported_field", fieldType: "INCLUDEPICTURE" });

  expect(
    screen.getByText(
      "This document contains a INCLUDEPICTURE field, which can't be converted.",
    ),
  ).toBeTruthy();
});

test("shows the legacy format and replacement extension", () => {
  mount({ kind: "legacy_format", replacementExtension: ".xlsx" });

  expect(
    screen.getByText(
      "This is a legacy Excel file. Re-save it as .xlsx to convert it.",
    ),
  ).toBeTruthy();
});

test("shows the document reference conversion refusal", () => {
  mount({
    kind: "unsupported_reference",
    format: "text/html",
    element: "x-thing",
    attribute: "src",
  });

  expect(
    screen.getByText(
      "This document refers to an external resource in x-thing src, so it can't be converted.",
    ),
  ).toBeTruthy();
});
