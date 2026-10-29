import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { cleanup, render, fireEvent } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ReaderAnswerLanguagePicker } =
  await import("./reader-answer-language-picker");
const messages = (await import("@/i18n/langs/en.json")).default;
afterEach(cleanup);
afterAll(async () => await unregisterDomEnvironment());

test.each(["sk", "cs", "pl"])(
  "offers document and every shipped UI language for an English UI over %s",
  async (documentLanguage) => {
    const changed: string[] = [];
    const view = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ReaderAnswerLanguagePicker
          documentLanguage={documentLanguage}
          value="document"
          disabled={false}
          onChange={(value) => {
            changed.push(value);
          }}
        />
      </IntlProvider>,
    );
    fireEvent.click(
      view.getByRole("button", { name: messages.readerAnswers.answerLanguage }),
    );
    const documentOption = await view.findByRole("menuitemradio", {
      name: /Document language/u,
    });
    expect(documentOption.getAttribute("aria-checked")).toBe("true");
    const { supportedLanguages, LANG_ENDONYMS } =
      await import("@/i18n/i18n-store");
    for (const language of supportedLanguages) {
      expect(
        view.getByRole("menuitemradio", { name: LANG_ENDONYMS[language] }),
      ).toBeTruthy();
    }
    fireEvent.click(view.getByRole("menuitemradio", { name: "English" }));
    expect(changed).toEqual(["en"]);
  },
);

test("hides the language picker when UI and document languages match", () => {
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ReaderAnswerLanguagePicker
        documentLanguage="en-GB"
        value="en"
        disabled={false}
        onChange={() => undefined}
      />
    </IntlProvider>,
  );
  expect(view.queryByRole("button")).toBeNull();
});

test("keeps an active override reachable when UI and document languages match", async () => {
  const changed: string[] = [];
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ReaderAnswerLanguagePicker
        documentLanguage="en-GB"
        value="fr"
        disabled={false}
        onChange={(value) => {
          changed.push(value);
        }}
      />
    </IntlProvider>,
  );
  fireEvent.click(
    view.getByRole("button", { name: messages.readerAnswers.answerLanguage }),
  );
  fireEvent.click(
    await view.findByRole("menuitemradio", { name: /Document language/u }),
  );
  expect(changed).toEqual(["document"]);
});
