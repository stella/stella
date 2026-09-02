import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { ChatThreadOrigin } from "@stll/api-contract/chat";

import cs from "@/i18n/langs/cs.json";
import en from "@/i18n/langs/en.json";

import { ChatThreadOriginPrefix } from "./chat-thread-origin-prefix";

const LOCALES = { cs, en } as const;

const render = (
  origin: ChatThreadOrigin,
  locale: keyof typeof LOCALES = "en",
) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={LOCALES[locale]} timeZone="UTC">
      <ChatThreadOriginPrefix origin={origin} />
    </IntlProvider>,
  );

describe("chat thread origin prefix", () => {
  test("keeps original conversations unmarked", () => {
    expect(render("original")).toBe("");
  });

  test("renders source-chat provenance in the reader's locale", () => {
    expect(render("fork")).toContain("From another chat");
    expect(render("fork", "cs")).toContain("Z jiného chatu");
  });
});
