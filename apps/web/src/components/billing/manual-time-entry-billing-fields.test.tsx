import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

import { ManualTimeEntryBillingFields } from "./manual-time-entry-billing-fields";

describe("manual time entry billing controls", () => {
  for (const [locale, messages] of [
    ["en", en],
    ["ar", ar],
  ] as const) {
    test(`${locale}: internal hides billing controls while client renders the real billable control`, () => {
      const render = (activityGroup: "client" | "internal") =>
        renderToStaticMarkup(
          <IntlProvider locale={locale} messages={messages} timeZone="UTC">
            <ManualTimeEntryBillingFields
              activityGroup={activityGroup}
              billable
              id="billable-control"
              onBillableChange={() => undefined}
            />
          </IntlProvider>,
        );
      const client = render(TIME_ENTRY_ACTIVITY_GROUP.CLIENT);
      expect(client).toContain('role="checkbox"');
      expect(client).toContain('id="billable-control"');
      expect(client).toContain(messages.billing.billable);
      expect(render(TIME_ENTRY_ACTIVITY_GROUP.INTERNAL)).toBe("");
    });
  }
});
