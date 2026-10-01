import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { UnrestoredFieldsNotice } from "@/components/chat/unrestored-fields-notice";
import messages from "@/i18n/langs/en.json";

const render = (output: unknown) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <UnrestoredFieldsNotice output={output} />
    </IntlProvider>,
  );

describe("template fields not filled with real values", () => {
  test("names each field a template tool could not fill", () => {
    const markup = render({
      text: "Signed by Dana Novotná.",
      unrestoredFields: ["witness.name", "party.address"],
    });

    expect(markup).toContain(
      "2 fields could not be filled with real values in anonymized mode. Review: witness.name, party.address",
    );
  });

  test("stays hidden when every field was filled", () => {
    expect(render({ text: "Signed by Dana Novotná." })).toBe("");
    expect(render({ unrestoredFields: [] })).toBe("");
  });
});
