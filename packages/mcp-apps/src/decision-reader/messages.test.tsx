import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import {
  ReaderPresentationProvider,
  useReaderMessages,
} from "@stll/decision-reader/reader-adapters";
import { UI_LOCALES } from "@stll/locales";

import catalogues from "../shared/generated/reader-messages.json";
import { READER_MESSAGE_KEYS, READER_TEMPLATE_KEYS } from "./message-keys";
import { readerMessages } from "./messages";

const PROVISION_LABEL = "§ 5 odst. 2";
const DATE = "2026-10-09";

const MessageSample = () => {
  const messages = useReaderMessages();
  return (
    <>
      <p>{messages.provisionEffectiveFrom(DATE)}</p>
      <p>{messages.provisionPartTextUnavailable(PROVISION_LABEL)}</p>
      {Object.values(READER_MESSAGE_KEYS).map((key) => (
        <p key={key}>{messages[key]}</p>
      ))}
    </>
  );
};

for (const locale of UI_LOCALES) {
  test(`MCP reader renders complete localized messages in ${locale}`, () => {
    const messages = readerMessages(locale);
    const catalogue = catalogues[locale];
    expect(Object.keys(catalogue).toSorted()).toEqual(
      [
        ...Object.values(READER_MESSAGE_KEYS),
        ...READER_TEMPLATE_KEYS,
      ].toSorted(),
    );
    for (const key of Object.values(READER_MESSAGE_KEYS)) {
      expect(messages[key]).toBe(catalogue[key]);
      expect(messages[key].length).toBeGreaterThan(0);
    }
    const html = renderToStaticMarkup(
      <ReaderPresentationProvider adapters={{ messages }}>
        <MessageSample />
      </ReaderPresentationProvider>,
    );
    expect(html).toContain(PROVISION_LABEL);
    expect(html).toContain(DATE);
    expect(html).not.toContain("{provisionLabel}");
    expect(html).not.toContain("{date}");
    for (const key of Object.values(READER_MESSAGE_KEYS)) {
      expect(html).not.toContain(key);
    }
  });
}

for (const { locale, dateText, unavailableText } of [
  {
    locale: "en",
    dateText: "in force since 2026-10-09",
    unavailableText: "Text of § 5 odst. 2 is not available",
  },
  {
    locale: "cs",
    dateText: "účinné od 2026-10-09",
    unavailableText: "Znění § 5 odst. 2 není k dispozici",
  },
  {
    locale: "ar",
    dateText: "نافذ منذ 2026-10-09",
    unavailableText: "نص § 5 odst. 2 غير متاح",
  },
]) {
  test(`MCP reader interpolates the date and missing part in ${locale}`, () => {
    const html = renderToStaticMarkup(
      <ReaderPresentationProvider
        adapters={{ messages: readerMessages(locale) }}
      >
        <MessageSample />
      </ReaderPresentationProvider>,
    );
    expect(html).toContain(`<p>${dateText}</p>`);
    expect(html).toContain(`<p>${unavailableText}</p>`);
  });
}
