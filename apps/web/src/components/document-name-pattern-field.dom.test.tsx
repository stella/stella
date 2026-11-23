import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json" with { type: "json" };

GlobalRegistrator.register({
  url: "http://localhost:3000/settings/organization/general",
});
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { DocumentNamePatternField } =
  await import("./document-name-pattern-field");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = (value: string, problem: string | null) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DocumentNamePatternField
        onChange={() => undefined}
        problem={problem}
        value={value}
      />
    </IntlProvider>,
  );

test("previews the name a signed contract would get", () => {
  mount("{dateCompact}_{docType}_{title}", null);

  expect(
    screen.getByText("20260314_Contract_Share purchase agreement.pdf"),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("shows the problem instead of a preview for an invalid pattern", () => {
  mount("{party}", "Unrecognized token: {party}");

  expect(screen.getByRole("alert").textContent).toBe(
    messages.organization.documentNaming.invalid,
  );
  expect(screen.queryByText(/\.pdf$/u)).toBeNull();
});

test("shows no preview while the pattern is empty", () => {
  mount("", null);

  expect(screen.queryByText(/\.pdf$/u)).toBeNull();
});
