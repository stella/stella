import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Europe/Prague" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "Temporal", {
      value: undefined,
      configurable: true,
    });
  });
  await page.clock.install({ time: new Date("2026-03-08T12:00:00Z") });
  await page.goto("/src/components/fixtures/date-picker.fixture.html");
  await expect(page.locator("html")).toHaveAttribute(
    "data-date-picker-ready",
    "true",
  );
});

test("future bounds are opt-in and intersect the other bound", async ({
  page,
}) => {
  await page
    .getByRole("region", { name: "Past range" })
    .getByRole("button", { name: /^From/u })
    .click();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-09"]',
    ),
  ).toBeDisabled();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-08"]',
    ),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await page
    .getByRole("region", { name: "Any range" })
    .getByRole("button", { name: /^From/u })
    .click();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-09"]',
    ),
  ).toBeEnabled();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-10"]',
    ),
  ).toBeEnabled();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-11"]',
    ),
  ).toBeDisabled();
});

test("both calendars forbid crossing the selected range", async ({ page }) => {
  const range = page.getByRole("region", { name: "Any range" });
  await range.getByRole("button", { name: /^From/u }).click();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-11"]',
    ),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await range.getByRole("button", { name: /^To/u }).click();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-04"]',
    ),
  ).toBeDisabled();
  await expect(
    page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-05"]',
    ),
  ).toBeEnabled();
});

for (const activation of ["mouse", "Enter", "Space"]) {
  test(`picking From by ${activation} focuses To and opens its calendar`, async ({
    page,
  }) => {
    const range = page.getByRole("region", { name: "Any range" });
    await range.getByRole("button", { name: /^From/u }).click();
    const day = page.locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-06"]',
    );
    if (activation === "mouse") {
      await day.click();
    } else {
      await day.focus();
      await day.press(activation);
    }
    await expect(range.getByRole("button", { name: /^To/u })).toBeFocused();
    await expect(
      page.locator(
        '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"]',
      ),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="popover-popup"][data-open] input'),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-05"]',
      ),
    ).toBeDisabled();
    await expect(range.getByLabel("From value")).toHaveText("2026-03-06");
  });
}

test("typed dates outside either bound show an inline error without applying", async ({
  page,
}) => {
  const range = page.getByRole("region", { name: "Any range" });
  await range.getByRole("button", { name: /^From/u }).click();
  await page
    .locator('[data-slot="popover-popup"][data-open] input')
    .fill("2026-03-11");
  await page
    .locator('[data-slot="popover-popup"][data-open] input')
    .press("Enter");
  await expect(
    page.locator('[data-slot="popover-popup"][data-open]').getByRole("alert"),
  ).toHaveText("Choose a date within the allowed range.");
  await expect(range.getByLabel("From value")).toHaveText("2026-03-05");
  await page.keyboard.press("Escape");
  await range.getByRole("button", { name: /^To/u }).click();
  await page
    .locator('[data-slot="popover-popup"][data-open] input')
    .fill("2026-03-04");
  await page
    .locator('[data-slot="popover-popup"][data-open] input')
    .press("Enter");
  await expect(
    page.locator('[data-slot="popover-popup"][data-open]').getByRole("alert"),
  ).toBeVisible();
  await expect(range.getByLabel("To value")).toHaveText("2026-03-10");
});

test("typed future dates do not apply when the filter opts in", async ({
  page,
}) => {
  const range = page.getByRole("region", { name: "Past range" });
  await range.getByRole("button", { name: /^From/u }).click();
  await page
    .locator('[data-slot="popover-popup"][data-open] input')
    .fill("2026-03-09");
  await page
    .locator('[data-slot="popover-popup"][data-open] input')
    .press("Enter");
  await expect(
    page.locator('[data-slot="popover-popup"][data-open]').getByRole("alert"),
  ).toBeVisible();
  await expect(range.getByLabel("From value")).toHaveText("2026-03-05");
});

test("a single picker applies on click without an OK button", async ({
  page,
}) => {
  await page.locator("#single-apply").click();
  await page
    .locator(
      '[data-slot="popover-popup"][data-open] [data-slot="date-picker-popup"] [data-date="2026-03-06"]',
    )
    .click();
  await expect(page.getByLabel("Single value")).toHaveText("2026-03-06");
  await expect(page.getByRole("button", { name: /^(OK|Apply)$/u })).toHaveCount(
    0,
  );
});

for (const zone of ["Europe/Prague", "America/New_York"]) {
  test.describe(zone, () => {
    test.use({ timezoneId: zone });
    test("future limit follows the local calendar day across midnight", async ({
      page,
    }) => {
      await page.clock.setSystemTime(new Date("2026-03-08T23:30:00Z"));
      await page.reload();
      await page
        .getByRole("region", { name: "Past range" })
        .getByRole("button", { name: /^From/u })
        .click();
      const ninth = page.locator(
        '[data-slot="popover-popup"][data-open] [data-date="2026-03-09"]',
      );
      if (zone === "Europe/Prague") {
        await expect(ninth).toBeEnabled();
      } else {
        await expect(ninth).toBeDisabled();
      }
    });
  });
}

test("a valid typed date applies on Enter and hands off to To", async ({
  page,
}) => {
  const range = page.getByRole("region", { name: "Any range" });
  await range.getByRole("button", { name: /^From/u }).click();
  const input = page.locator('[data-slot="popover-popup"][data-open] input');
  await input.fill("2026-03-06");
  await input.press("Enter");
  await expect(range.getByLabel("From value")).toHaveText("2026-03-06");
  await expect(range.getByRole("button", { name: /^To/u })).toBeFocused();
});

for (const bound of ["From", "To"]) {
  for (const action of ["day", "clear"]) {
    test(`an edited ${bound} draft yields to the clicked ${action} action`, async ({
      page,
    }) => {
      const range = page.getByRole("region", { name: "Any range" });
      await range
        .getByRole("button", { name: new RegExp(`^${bound}`, "u") })
        .click();
      const popup = page.locator('[data-slot="popover-popup"][data-open]');
      const input = popup.locator("input");
      await input.fill("2026-03-07");
      await expect(input).toBeFocused();
      if (action === "day") {
        await popup.locator('[data-date="2026-03-08"]').click();
      } else {
        await popup
          .getByRole("button", { name: "Clear date", exact: true })
          .click();
      }
      await expect(range.getByLabel("Applied range changes")).toHaveText(
        `${bound}:${action === "day" ? "2026-03-08" : "empty"}`,
      );
      await expect(range.getByLabel(`${bound} value`)).toHaveText(
        action === "day" ? "2026-03-08" : "empty",
      );
      await expect(
        range.getByLabel(`${bound === "From" ? "To" : "From"} value`),
      ).toHaveText(bound === "From" ? "2026-03-10" : "2026-03-05");
    });
  }
}

for (const bound of ["From", "To"]) {
  test(`an edited ${bound} draft still applies when focus leaves the popup`, async ({
    page,
  }) => {
    const range = page.getByRole("region", { name: "Any range" });
    await range
      .getByRole("button", { name: new RegExp(`^${bound}`, "u") })
      .click();
    const input = page.locator('[data-slot="popover-popup"][data-open] input');
    await input.fill("2026-03-07");
    await page.locator("#single-apply").focus();
    await expect(range.getByLabel(`${bound} value`)).toHaveText("2026-03-07");
  });
}

for (const bound of ["From", "To"]) {
  test(`a typed ${bound} date commits after Tab traverses the footer and leaves the popup`, async ({
    page,
  }) => {
    const range = page.getByRole("region", { name: "Any range" });
    await range
      .getByRole("button", { name: new RegExp(`^${bound}`, "u") })
      .click();
    const popup = page.locator('[data-slot="popover-popup"][data-open]');
    await popup.locator("input").fill("2026-03-07");
    await page.keyboard.press("Tab");
    await expect(
      popup.getByRole("button", { name: "Today", exact: true }),
    ).toBeFocused();
    await expect(range.getByLabel("Applied range changes")).toHaveText("");
    await page.keyboard.press("Tab");
    await expect(
      popup.getByRole("button", { name: "Clear date", exact: true }),
    ).toBeFocused();
    await expect(range.getByLabel("Applied range changes")).toHaveText("");
    await page.keyboard.press("Tab");
    await expect(range.getByLabel(`${bound} value`)).toHaveText("2026-03-07");
    await expect(range.getByLabel("Applied range changes")).toHaveText(
      `${bound}:2026-03-07`,
    );
    if (bound === "From") {
      await expect(range.getByRole("button", { name: /^To/u })).toBeFocused();
      await expect(
        page.locator('[data-slot="popover-popup"][data-open] input'),
      ).toHaveValue("2026-03-10");
    }
  });

  test(`Today navigation discards an edited ${bound} draft before popup exit`, async ({
    page,
  }) => {
    const range = page.getByRole("region", { name: "Any range" });
    await range
      .getByRole("button", { name: new RegExp(`^${bound}`, "u") })
      .click();
    const popup = page.locator('[data-slot="popover-popup"][data-open]');
    await popup.locator("input").fill("2026-03-07");
    await popup.getByRole("button", { name: "Today", exact: true }).click();
    await page.locator("#single-apply").focus();
    await expect(range.getByLabel("Applied range changes")).toHaveText("");
    await expect(range.getByLabel(`${bound} value`)).toHaveText(
      bound === "From" ? "2026-03-05" : "2026-03-10",
    );
  });
}

for (const bound of ["From", "To"]) {
  test(`composing Enter preserves the ${bound} draft and candidate confirmation`, async ({
    page,
  }) => {
    const range = page.getByRole("region", { name: "Any range" });
    await range
      .getByRole("button", { name: new RegExp(`^${bound}`, "u") })
      .click();
    const input = page.locator('[data-slot="popover-popup"][data-open] input');
    await input.fill("2026-03-07");
    const composition = await input.evaluate((element) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
      return {
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
      };
    });
    expect(composition).toEqual({
      isComposing: true,
      defaultPrevented: false,
    });
    await expect(range.getByLabel("Applied range changes")).toHaveText("");
    await expect(range.getByLabel(`${bound} value`)).toHaveText(
      bound === "From" ? "2026-03-05" : "2026-03-10",
    );
    await expect(input).toHaveValue("2026-03-07");
    await input.press("Enter");
    await expect(range.getByLabel("Applied range changes")).toHaveText(
      `${bound}:2026-03-07`,
    );
  });
}
