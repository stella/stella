import { expect, test } from "@playwright/test";

test("rebuilds rotated pages from masked pixels and removes source data", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(
    async () => await window.runAnonymizedExportCheck(),
  );

  expect(result.source.pageCount).toBe(2);
  expect(result.source.pageRotations).toEqual([0, 90]);
  expect(result.source.attachmentCount).toBe(1);
  expect(result.source.metadata.author).toBe("Privileged author");
  expect(result.source.metadata.title).toBe("Privileged matter title");
  expect(result.source.text).toContain("Secret Person");
  expect(result.source.text).toContain("secret@example.test");

  expect(result.output.pageCount).toBe(2);
  expect(result.output.attachmentCount).toBe(0);
  expect(result.output.text).toBe("");
  expect(JSON.stringify(result.output.metadata)).not.toContain("Privileged");
  expect(result.output.pageRotations).toEqual([0, 0]);

  expect(result.pixels).toHaveLength(2);
  expect(result.pixels.map(({ width, height }) => [width, height])).toEqual([
    [800, 320],
    [320, 800],
  ]);
  for (const pixels of result.pixels) {
    expect(pixels.blackMaskPixelRatio).toBeGreaterThan(0.99);
    expect(pixels.visualMeanAbsoluteError).toBeLessThan(0.5);
  }
});

test("rejects mixed image and vector content before export", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(
    await page.evaluate(async () => await window.runUnsupportedExportCheck()),
  ).toEqual([true, true]);
});

test("rejects oversized pages and cumulative document rasters", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(
    await page.evaluate(
      async () =>
        await window.runExportLimitCheck({ pageCount: 1, pageSize: 2001 }),
    ),
  ).toBe("A page exceeds the anonymized export size limit");
  // Each page fits the individual limit; only their combined size is excessive.
  expect(
    await page.evaluate(
      async () =>
        await window.runExportLimitCheck({ pageCount: 5, pageSize: 2000 }),
    ),
  ).toBe("The document exceeds the anonymized export size limit");
});

test("blacks out text under an area drawn with the mouse", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const secrets = await page.evaluate(
    async () => await window.showManualRedactionPages(),
  );
  expect(secrets).toHaveLength(2);
  // Drag from just outside the secret's corner to just past the opposite one.
  for (const secret of secrets) {
    await page.mouse.move(secret.left - 3, secret.top - 3);
    await page.mouse.down();
    await page.mouse.move(secret.right + 3, secret.bottom + 3, { steps: 5 });
    await page.mouse.up();
  }

  const result = await page.evaluate(
    async () => await window.runManualRedactionExportCheck(),
  );

  expect(result.areaCount).toBe(2);
  expect(result.sourceText).toContain("Undetected 4711");
  expect(result.outputText).toBe("");
  expect(result.secretBlackRatio).toHaveLength(2);
  for (const { source, output } of result.secretBlackRatio) {
    // Glyphs alone leave most of the secret's box unpainted.
    expect(source).toBeLessThan(0.5);
    expect(output).toBeGreaterThan(0.99);
  }
  expect(result.areaBlackRatio).toHaveLength(2);
  for (const ratio of result.areaBlackRatio) {
    expect(ratio).toBeGreaterThan(0.99);
  }
  expect(result.otherDocumentError).toBe(
    "The marked areas were drawn on a different version of the file",
  );
  expect(result.otherPageSizeError).toBe(
    "The marked areas were drawn on a different version of the file",
  );
});
