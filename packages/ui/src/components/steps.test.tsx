import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Step, Steps } from "./steps";

test.each(["decimal", "arabic-indic"] as const)(
  "Steps keeps %s numbering on its native ordered list",
  (markerStyle) => {
    const markup = renderToStaticMarkup(
      <Steps markerStyle={markerStyle}>
        <Step>Prepare</Step>
        <Step>Review</Step>
      </Steps>,
    );

    expect(markup).toContain("<ol");
    expect(markup).toContain(`list-style-type:${markerStyle}`);
    expect(markup.match(/<li/gu)).toHaveLength(2);
    expect(markup).not.toMatch(/>0?1[.)]</u);
  },
);
