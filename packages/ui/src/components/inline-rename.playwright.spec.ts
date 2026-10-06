import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const fixturePath = "/src/components/fixtures/inline-rename.fixture.html";
const TOLERANCE_PX = 1;

test.use({
  viewport: { width: 900, height: 600 },
  isMobile: false,
  hasTouch: false,
});

const metrics = async (locator: Locator) =>
  await locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      rect: { x, y, width, height },
      font: {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      },
    };
  });

const openEditor = async (page: Page) => {
  await page.locator("[data-title-view]").click();
  const input = page.getByRole("textbox", { name: "Title" });
  await expect(input).toBeFocused();
  return input;
};

for (const scenario of [
  { name: "desktop", query: "", width: 900 },
  { name: "narrow", query: "", width: 320 },
  { name: "Arabic RTL", query: "?rtl=true", width: 900 },
  { name: "mirror fallback", query: "?fallback=true", width: 900 },
]) {
  test(`preserves title geometry, typography and selection on ${scenario.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 600 });
    await page.goto(fixturePath + scenario.query);
    const before = await metrics(page.locator("[data-title-view]"));
    const input = await openEditor(page);
    const after = await metrics(input);
    if (scenario.query.includes("fallback")) {
      expect(
        await input.evaluate((element) =>
          getComputedStyle(element).getPropertyValue("field-sizing"),
        ),
      ).toBe("fixed");
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(after.rect[key] - before.rect[key]),
        key,
      ).toBeLessThanOrEqual(TOLERANCE_PX);
    }
    expect(after.font).toEqual(before.font);
    expect(
      await input.evaluate((element: HTMLInputElement) => ({
        start: element.selectionStart,
        end: element.selectionEnd,
        length: element.value.length,
      })),
    ).toEqual({
      start: 0,
      end: (await input.inputValue()).length,
      length: (await input.inputValue()).length,
    });
  });
}

for (const query of [
  "",
  "?fallback=true",
  "?rtl=true",
  "?fallback=true&rtl=true",
  "?narrow=true",
]) {
  test(`grows with text and scrolls within available width ${query || "native"}`, async ({
    page,
  }) => {
    if (query.includes("narrow")) {
      await page.setViewportSize({ width: 320, height: 600 });
    }
    await page.goto(fixturePath + query);
    const input = await openEditor(page);
    const initial = await metrics(input);
    await input.fill("Contract review with more text");
    expect((await metrics(input)).rect.width).toBeGreaterThan(
      initial.rect.width,
    );
    await input.fill("Contract review ".repeat(30));
    const limit = await page
      .locator("[data-title-container]")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect((await metrics(input)).rect.width).toBeLessThanOrEqual(
      limit + TOLERANCE_PX,
    );
    expect((await metrics(input)).rect.width).toBeGreaterThanOrEqual(
      limit - TOLERANCE_PX,
    );
    await input.press("End");
    await input.press("ArrowLeft");
    expect(
      await input.evaluate(
        (element: HTMLInputElement) =>
          element.scrollWidth > element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await input.evaluate((element) => Math.abs(element.scrollLeft)),
    ).toBeGreaterThan(0);
  });
}

test("Enter commits the edited title", async ({ page }) => {
  await page.goto(fixturePath);
  const input = await openEditor(page);
  await input.fill("Updated contract");
  await input.press("Enter");
  await expect(page.locator("[data-title-view]")).toHaveText(
    "Updated contract",
  );
  await expect(page.locator("output")).toHaveText("committed");
});

test("Escape restores the original title", async ({ page }) => {
  await page.goto(fixturePath);
  const input = await openEditor(page);
  await input.fill("Discard this");
  await input.press("Escape");
  await expect(page.locator("[data-title-view]")).toHaveText("Contract review");
  await expect(page.locator("output")).toHaveText("cancelled");
});

test("blur commits the edited title", async ({ page }) => {
  await page.goto(fixturePath);
  const input = await openEditor(page);
  await input.fill("Updated on blur");
  await page.getByRole("button", { name: "Outside" }).click();
  await expect(page.locator("[data-title-view]")).toHaveText("Updated on blur");
  await expect(page.locator("output")).toHaveText("committed");
});

for (const theme of ["light", "dark"]) {
  test(`captures unchanged title typography in ${theme} mode`, async ({
    page,
  }) => {
    await page.goto(`${fixturePath}?theme=${theme}`);
    await expect(page.locator("[data-title-view]")).toBeVisible();
    await page.screenshot({
      path: `../../state/inline-rename-${theme}-view.png`,
    });
    await openEditor(page);
    await page.screenshot({
      path: `../../state/inline-rename-${theme}-edit.png`,
    });
  });
}

test("exposes the actual input through its forwarded ref", async ({ page }) => {
  await page.goto(fixturePath);
  const input = await openEditor(page);
  await expect(input).toHaveAttribute("data-ref-exposed", "true");
});

for (const key of ["Enter", "Escape"]) {
  test(`${key} does not commit again when the completed editor blurs`, async ({
    page,
  }) => {
    await page.goto(`${fixturePath}?retain=true`);
    const input = await openEditor(page);
    await input.press(key);
    await page.getByRole("button", { name: "Outside" }).click();
    await expect(page.locator("output")).toHaveAttribute(
      "data-commits",
      key === "Enter" ? "1" : "0",
    );
    await expect(page.locator("output")).toHaveAttribute(
      "data-cancels",
      key === "Escape" ? "1" : "0",
    );
  });
}

test("allows a corrected draft to commit on blur after validation retained the editor", async ({
  page,
}) => {
  await page.goto(`${fixturePath}?retain=true`);
  const input = await openEditor(page);
  await input.fill("Rejected draft");
  await input.press("Enter");
  await expect(page.locator("output")).toHaveAttribute("data-commits", "1");
  await input.fill("Corrected draft");
  await page.getByRole("button", { name: "Outside" }).click();
  await expect(page.locator("output")).toHaveAttribute("data-commits", "2");
});

test("an empty field keeps its placeholder's width in the mirror fallback", async ({
  page,
}) => {
  await page.goto(`${fixturePath}?fallback=true&empty=true`);
  const input = await openEditor(page);
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute("placeholder", "Add reference");
  const { inputWidth, placeholderWidth } = await input.evaluate((element) => {
    const probe = document.createElement("span");
    probe.textContent = "Add reference";
    probe.style.font = getComputedStyle(element).font;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const measured = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      inputWidth: element.getBoundingClientRect().width,
      placeholderWidth: measured,
    };
  });
  expect(inputWidth).toBeGreaterThanOrEqual(placeholderWidth - TOLERANCE_PX);
});

test("a parent-supplied draft after a retained commit still commits on blur", async ({
  page,
}) => {
  await page.goto(`${fixturePath}?retain=true`);
  const input = await openEditor(page);
  await input.fill("Rejected draft");
  await input.press("Enter");
  await expect(page.locator("output")).toHaveAttribute("data-commits", "1");
  await page.evaluate(() => {
    const setFixtureDraft: unknown = Reflect.get(window, "setFixtureDraft");
    if (typeof setFixtureDraft !== "function") {
      throw new TypeError("the fixture does not expose its draft setter");
    }
    Reflect.apply(setFixtureDraft, window, ["Corrected by parent"]);
  });
  await expect(input).toHaveValue("Corrected by parent");
  await page.getByRole("button", { name: "Outside" }).click();
  await expect(page.locator("output")).toHaveAttribute("data-commits", "2");
});

for (const { fallback, rtl } of [
  { fallback: false, rtl: false },
  { fallback: true, rtl: false },
  { fallback: false, rtl: true },
]) {
  test(`a fill field spans its row whatever its text (fallback=${String(fallback)}, rtl=${String(rtl)})`, async ({
    page,
  }) => {
    await page.goto(
      `${fixturePath}?fill=true&fallback=${String(fallback)}&rtl=${String(rtl)}`,
    );
    const input = await openEditor(page);
    await input.fill("A");
    const { container, field, rowTop, fieldTop } = await input.evaluate(
      (element) => {
        const row = element.closest("[data-title-container]");
        if (!(row instanceof HTMLElement)) {
          throw new Error("the fill field is missing its row");
        }
        const rowBox = row.getBoundingClientRect();
        const fieldBox = element.getBoundingClientRect();
        return {
          container: rowBox.width,
          field: fieldBox.width,
          rowTop: rowBox.top,
          fieldTop: fieldBox.top,
        };
      },
    );
    expect(field).toBeGreaterThanOrEqual(container - TOLERANCE_PX);
    // The field stays on the row's first line instead of below the mirror.
    expect(Math.abs(fieldTop - rowTop)).toBeLessThanOrEqual(TOLERANCE_PX);
  });
}
