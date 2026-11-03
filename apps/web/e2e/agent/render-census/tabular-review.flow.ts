import { expect } from "@playwright/test";
import { panic } from "better-result";
import * as v from "valibot";

import { apiGet, apiPut } from "../../helpers/api";
import { deleteTestWorkspace } from "../../helpers/workspace";
import type { DriveScriptContext } from "../drive-context";
import { createLegalMatter } from "./fixture-setup";
import { REVIEW_COLUMNS, reviewRecord } from "./legal-fixtures";

const propertyList = v.array(v.object({ id: v.string(), name: v.string() }));
const entityCreated = v.object({ entityId: v.string() });

const runTabularReviewCensus = async ({
  page,
  apiUrl,
  measureAction,
}: DriveScriptContext) => {
  for (const rows of [50, 500]) {
    const matter = await createLegalMatter(
      page.request,
      `Posouzení smluvních podkladů – ${String(rows)} listin`,
    );
    try {
      await apiPut(page.request, `/properties/${matter.id}/batch`, {
        items: REVIEW_COLUMNS.map((name) => ({
          name,
          contentType: "text",
          toolType: "manual-input",
        })),
      });
      const properties = v.parse(
        propertyList,
        await apiGet(page.request, `/properties/${matter.id}`),
      );
      const reviewProperties = properties.filter(({ name }) =>
        REVIEW_COLUMNS.some((column) => column === name),
      );
      if (properties.length !== 10 || reviewProperties.length !== 9) {
        panic("Tabular census needs nine manual columns plus the file column");
      }
      // Bound setup concurrency; the measured actions start after every cell is saved.
      for (let start = 0; start < rows; start += 8) {
        await Promise.all(
          Array.from(
            { length: Math.min(8, rows - start) },
            async (_, offset) => {
              const row = start + offset;
              const created = v.parse(
                entityCreated,
                await apiPut(page.request, `/entities/${matter.id}`, {
                  name: reviewRecord({ index: row, rowCount: rows }).name,
                  kind: "document",
                }),
              );
              await Promise.all(
                reviewProperties.map(async (property) => {
                  const column = REVIEW_COLUMNS.find(
                    (name) => name === property.name,
                  );
                  if (column === undefined) {
                    panic("Review column has no fixture value");
                  }
                  const response = await page.request.post(
                    `${apiUrl}/v1/fields/${matter.id}`,
                    {
                      data: {
                        entityId: created.entityId,
                        propertyId: property.id,
                        content: {
                          type: "text",
                          value: reviewRecord({ index: row, rowCount: rows })
                            .values[column],
                        },
                      },
                    },
                  );
                  if (!response.ok()) {
                    panic(
                      `Tabular census cell setup failed: ${String(response.status())}: ${await response.text()}`,
                    );
                  }
                  await response.dispose();
                }),
              );
            },
          ),
        );
      }
      await page.goto(`/workspaces/${matter.id}`, {
        waitUntil: "domcontentloaded",
      });
      await page.getByRole("tab", { name: "Table", exact: true }).click();
      const first = page.getByText(
        reviewRecord({ index: 0, rowCount: rows }).name,
        { exact: true },
      );
      await expect(first).toBeVisible({ timeout: 30_000 });
      const scroll = page.locator('[data-slot="workspace-table-scroll"]');
      await expect(scroll).toBeVisible();
      await scroll.hover();
      await measureAction(
        `table ${String(rows)} rows: scroll top to bottom`,
        async () => {
          const height = await scroll.evaluate(
            (element) => element.scrollHeight,
          );
          for (let distance = 0; distance < height; distance += 600) {
            await page.mouse.wheel(0, 600);
          }
          await expect(
            page.getByText(
              reviewRecord({ index: rows - 1, rowCount: rows }).name,
              {
                exact: true,
              },
            ),
          ).toBeVisible();
        },
      );
      // Home reaches the first virtualized rows through the same keyboard input.
      await scroll.click({ position: { x: 8, y: 8 } });
      await page.keyboard.press("ControlOrMeta+Home");
      const column = page
        .getByRole("columnheader")
        .filter({ hasText: REVIEW_COLUMNS[0] });
      await measureAction(
        `table ${String(rows)} rows: sort ascending`,
        async () => {
          await column.click();
          await page
            .getByRole("button", { name: "A → Z", exact: true })
            .click();
          await page.keyboard.press("Escape");
          await expect(
            page.getByText(
              reviewRecord({ index: rows - 1, rowCount: rows }).name,
              {
                exact: true,
              },
            ),
          ).toBeVisible();
        },
      );
      await measureAction(
        `table ${String(rows)} rows: sort descending`,
        async () => {
          await column.click();
          await page
            .getByRole("button", { name: "Z → A", exact: true })
            .click();
          await page.keyboard.press("Escape");
          await expect(first).toBeVisible();
        },
      );
    } finally {
      await page.goto("/workspaces", { waitUntil: "domcontentloaded" });
      await deleteTestWorkspace(page.request, matter.id);
    }
  }
};

export default runTabularReviewCensus;
