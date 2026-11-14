import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { DECISION_TEXT_AVAILABILITY } from "@stll/api-contract/case-law-text-field";

import { DecisionTextAvailabilityMarker } from "@/features/case-law/components/decision-text-availability";
import messages from "@/i18n/langs/en.json";

test.each(Object.values(DECISION_TEXT_AVAILABILITY))(
  "%s decisions only show a no-text marker when metadata is all that is held",
  (availability) => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" timeZone="UTC" messages={messages}>
        <DecisionTextAvailabilityMarker availability={availability} />
      </IntlProvider>,
    );
    expect(
      markup.includes(messages.caseLaw.research.answers.failureReasons.noText),
    ).toBe(availability === DECISION_TEXT_AVAILABILITY.METADATA_ONLY);
  },
);
