import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ScopeMark } = await import("./paragraph-scope");
const english = (await import("@/i18n/langs/en.json")).default;
const arabic = (await import("@/i18n/langs/ar.json")).default;

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const mount = (
  scope: Parameters<typeof ScopeMark>[0]["scope"],
  locale: "en" | "ar" = "en",
) =>
  render(
    <IntlProvider
      locale={locale}
      messages={locale === "ar" ? arabic : english}
      timeZone="UTC"
    >
      <div dir={locale === "ar" ? "rtl" : "ltr"}>
        <ScopeMark scope={scope} />
      </div>
    </IntlProvider>,
  );

const range = {
  kind: "paragraphs",
  from: 82,
  to: 136,
  numbering: "document",
  start: { blockId: "P18", offset: 1103 },
  end: { blockId: "P32", offset: 1006 },
} as const;

test("a run header names the paragraphs a range run checked", () => {
  const { container } = mount(range);
  expect(container.textContent).toBe("¶ 82–136");
});

test("a run over the whole document says nothing extra", () => {
  const { container } = mount({ kind: "whole" });
  expect(container.textContent).toBe("");
});

test("in a right-to-left locale the range still reads from its first paragraph", () => {
  const { container } = mount(range, "ar");
  const isolated = container.querySelector("bdi");
  expect(isolated?.getAttribute("dir")).toBe("ltr");
  expect(isolated?.textContent).toBe("82–136");
});
