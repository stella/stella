import { expect, test } from "@playwright/test";

import { findPhoneLayoutProblems } from "../helpers/phone-layout";

test.use({ storageState: { cookies: [], origins: [] } });

for (const { distance, crowded } of [
  { distance: 23, crowded: true },
  { distance: 24, crowded: false },
  { distance: 25, crowded: false },
]) {
  test(`undersized targets with centres ${distance}px apart respect circle spacing`, async ({
    page,
  }) => {
    // safe-html: static test controls with a numeric fixture offset.
    await page.setContent(`
      <style>
        button { position: absolute; top: 50px; width: 10px; height: 10px; padding: 0; border: 0; }
        #first { left: 50px; }
        #second { left: ${50 + distance}px; }
      </style>
      <button id="first" aria-label="First"></button>
      <button id="second" aria-label="Second"></button>
    `);
    const problems = await findPhoneLayoutProblems(page);
    expect(problems.some((problem) => problem === "small touch targets:")).toBe(
      crowded,
    );
    expect(problems).toHaveLength(crowded ? 3 : 0);
  });
}
