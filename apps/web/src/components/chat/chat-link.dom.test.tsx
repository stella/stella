import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { ChatLink } = await import("@stll/chat/link");
const locales = [
  { locale: "en", catalogue: (await import("@/i18n/langs/en.json")).default },
  { locale: "cs", catalogue: (await import("@/i18n/langs/cs.json")).default },
  { locale: "ar", catalogue: (await import("@/i18n/langs/ar.json")).default },
];

afterEach(cleanup);
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const { locale, catalogue } of locales) {
  test(`${locale} links keep the decorative icon before an isolated title and safe new-tab anchor`, () => {
    const label = locale === "ar" ? "مصدر الحكم" : "Decision source";
    const view = render(
      <div dir={locale === "ar" ? "rtl" : "ltr"} lang={locale}>
        <ChatLink
          href="https://github.com/stella/stella"
          newTabLabel={catalogue.common.openInNewTab}
        >
          {label}
        </ChatLink>
      </div>,
    );
    const link = view.getByRole("link", { name: label });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("title")).toBe(catalogue.common.openInNewTab);
    expect(link.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(link.firstElementChild?.querySelector("svg")).not.toBeNull();
    expect(link.children.item(1)?.tagName).toBe("BDI");
    expect(link.children.item(1)?.textContent).toBe(label);
    fireEvent.mouseEnter(link);
    fireEvent.focus(link);
    expect(view.container.querySelector("img")).toBeNull();
  });
}

test("bare link titles use the hostname and only exact brand hosts receive a mark", () => {
  const raw = "https://github.com/stella/stella";
  const xLabel = "X source";
  const otherLabel = "Other source";
  const view = render(
    <>
      <ChatLink href="https://github.com/stella/stella">{raw}</ChatLink>
      <ChatLink href="https://x.com/stella">{xLabel}</ChatLink>
      <ChatLink href="https://github.com.evil.org/stella">
        {otherLabel}
      </ChatLink>
    </>,
  );
  expect(
    view.getByRole("link", { name: "github.com" }).getAttribute("href"),
  ).toBe("https://github.com/stella/stella");
  expect(
    view
      .getByRole("link", { name: "X source" })
      .querySelector("svg")
      ?.getAttribute("viewBox"),
  ).toBe("0 0 24 24");
  expect(
    view
      .getByRole("link", { name: "Other source" })
      .querySelector("svg")
      ?.classList.contains("lucide-globe"),
  ).toBe(true);
});

test("the proxy seam cannot render a third-party icon and failed local images return to globe", () => {
  const label = "stella";
  const view = render(
    <ChatLink
      href="https://stll.app"
      iconSource={{ type: "proxy", src: "https://stll.app/favicon.ico" }}
    >
      {label}
    </ChatLink>,
  );
  expect(view.container.querySelector("img")).toBeNull();
  view.rerender(
    <ChatLink
      href="https://stll.app"
      iconSource={{ type: "proxy", src: "blob:http://localhost/icon" }}
    >
      {label}
    </ChatLink>,
  );
  const icon = view.container.querySelector("img");
  expect(icon?.getAttribute("src")).toBe("blob:http://localhost/icon");
  if (!icon) {
    throw new TypeError("Expected a local proxy icon");
  }
  fireEvent.error(icon);
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.getByRole("link", { name: label }).getAttribute("href")).toBe(
    "https://stll.app/",
  );
});

test("explicit mail and same-document destinations stay clickable while executable URLs stay plain", () => {
  const label = "Contact source";
  for (const href of [
    "mailto:contact@example.org",
    "#paragraph",
    "/law/cz/statutes",
  ]) {
    const view = render(<ChatLink href={href}>{label}</ChatLink>);
    expect(view.getByRole("link", { name: label }).getAttribute("href")).toBe(
      href,
    );
    cleanup();
  }
  for (const href of [
    "data:text/html,test",
    "//example.org",
    "/\\example.org",
  ]) {
    const view = render(<ChatLink href={href}>{label}</ChatLink>);
    expect(view.queryByRole("link")).toBeNull();
    cleanup();
  }
});

test("a root-relative path containing a public hostname retains the current origin", () => {
  const label = "Relative destination";
  const href = "/github.com/stella";
  const view = render(<ChatLink href={href}>{label}</ChatLink>);
  const link = view.getByRole("link", { name: label });
  expect(link.getAttribute("href")).toBe(href);
  expect(
    new URL(link.getAttribute("href") ?? "", window.location.href).origin,
  ).toBe(window.location.origin);
  expect(link.querySelector("svg")).toBeNull();
});
