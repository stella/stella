import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  DECISION_TEXT_AVAILABILITY,
  decisionTextStatusMarker,
} from "@stll/api-contract/case-law-text-field";
import { CASE_LAW_TEXT_STATUS } from "@stll/api-contract/case-law-text-status";

import { DecisionTextAvailabilityMarker } from "@/features/case-law/components/decision-text-availability";
import messages from "@/i18n/langs/en.json";

test.each(Object.values(DECISION_TEXT_AVAILABILITY))(
  "%s decisions only show a no-text marker when metadata is all that is held",
  (availability) => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" timeZone="UTC" messages={messages}>
        <DecisionTextAvailabilityMarker
          availability={availability}
          textState={null}
        />
      </IntlProvider>,
    );
    expect(
      markup.includes(messages.caseLaw.research.answers.failureReasons.noText),
    ).toBe(availability === DECISION_TEXT_AVAILABILITY.METADATA_ONLY);
  },
);

test.each(Object.values(CASE_LAW_TEXT_STATUS))(
  "%s has its own marker regardless of legacy availability",
  (textState) => {
    for (const availability of Object.values(DECISION_TEXT_AVAILABILITY)) {
      const markup = renderToStaticMarkup(
        <IntlProvider locale="en" messages={messages}>
          <DecisionTextAvailabilityMarker
            availability={availability}
            textState={textState}
          />
        </IntlProvider>,
      );
      const key = decisionTextStatusMarker(textState, availability);
      if (key === null) {
        expect(markup).toBe("");
      } else {
        expect(markup).toContain(
          key === "noDecisionText"
            ? messages.caseLaw.research.answers.failureReasons.noText
            : messages.caseLaw.textState[key],
        );
      }
    }
  },
);
