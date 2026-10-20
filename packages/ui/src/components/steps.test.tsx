import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { Step, Steps } from "./steps";

test("Steps keeps sequence numbering on its native ordered list", () => {
  const markup = renderToStaticMarkup(
    <Steps>
      <Step>Prepare</Step>
      <Step>Review</Step>
    </Steps>,
  );

  expect(markup).toContain("<ol");
  expect(markup.match(/<li/gu)).toHaveLength(2);
  expect(markup).not.toMatch(/>0?1[.)]</u);
});
