import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiPut, apiStatus, apiUploadDocx } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_PATH = path.resolve(import.meta.dirname, "../fixtures/simple.docx");

test.describe("find in table", () => {
  let workspace: TestWorkspace | null = null;

  test.beforeEach(async ({ request }) => {
    workspace = await createTestWorkspace(request, "table-search");
  });

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }

    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("Cmd/Ctrl+F narrows the rows to the term and marks it", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const suffix = randomUUID().slice(0, 8);
    const matchingName = `alpha-lease-${suffix}.docx`;
    const otherName = `beta-invoice-${suffix}.docx`;
    const docx = await readFile(DOCX_PATH);

    await Promise.all(
      [matchingName, otherName].map(
        async (name) =>
          await apiUploadDocx(
            request,
            testWorkspace.id,
            testWorkspace.filePropertyId,
            { name, mimeType: DOCX_MIME, buffer: docx },
          ),
      ),
    );

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        {
          message: "browser context can read the created workspace",
          timeout: 10_000,
        },
      )
      .toBe(200);

    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await tableTab.click();

    const matchingRow = page.getByRole("button", {
      exact: true,
      name: matchingName,
    });
    const otherRow = page.getByRole("button", { exact: true, name: otherName });
    await expect(matchingRow).toBeVisible({ timeout: 30_000 });
    await expect(otherRow).toBeVisible();

    await page.keyboard.press("ControlOrMeta+f");
    const findInput = page.getByRole("searchbox");
    await expect(findInput).toBeFocused();

    await findInput.fill("alpha");

    await expect(otherRow).toBeHidden({ timeout: 15_000 });
    await expect(matchingRow).toBeVisible();
    await expect(page.locator("mark").first()).toHaveText("alpha");

    // Escape closes the bar, not the find: the rows stay narrowed and the
    // chip is what now says why.
    await findInput.press("Escape");
    await expect(findInput).toBeHidden();
    const findChip = page.getByRole("button", { exact: true, name: "alpha" });
    await expect(findChip).toBeVisible();
    await expect(otherRow).toBeHidden();
    await expect(page.locator("mark").first()).toHaveText("alpha");

    // The chip reopens the bar on the term it applied.
    await findChip.click();
    await expect(findInput).toHaveValue("alpha");

    // An outside press is the same story: Base UI closes the popover on any
    // click elsewhere, which is how opening a matched row used to drop it.
    await tableTab.click();
    await expect(findInput).toBeHidden();
    await expect(otherRow).toBeHidden();
    await expect(page.locator("mark").first()).toHaveText("alpha");

    await findChip
      .locator("xpath=..")
      .getByRole("button", { exact: true, name: "Remove" })
      .click();
    await expect(findChip).toBeHidden();
    await expect(otherRow).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("mark")).toHaveCount(0);
  });

  // The submit debounces, and one toolbar serves every table view in a matter:
  // a switch between two of them leaves the component mounted with a timer
  // still pending. A timer that read the view when it fired rather than when
  // it was scheduled submitted the term against whichever view the reader had
  // moved to, and the view it was typed into kept a term it never applied.
  //
  // Going back is what makes the switch, rather than clicking the other view's
  // tab: a tab click is an outside press, which closes the bar and flushes the
  // pending submit on the way out.
  test("applies a term to the view it was typed into, not the one switched to", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const suffix = randomUUID().slice(0, 8);
    const matchingName = `alpha-lease-${suffix}.docx`;
    const otherName = `beta-invoice-${suffix}.docx`;
    const docx = await readFile(DOCX_PATH);
    const secondViewName = `Second table ${suffix}`;

    await Promise.all([
      ...[matchingName, otherName].map(
        async (name) =>
          await apiUploadDocx(
            request,
            testWorkspace.id,
            testWorkspace.filePropertyId,
            { name, mimeType: DOCX_MIME, buffer: docx },
          ),
      ),
      apiPut(request, `/views/${testWorkspace.id}`, {
        id: randomUUID(),
        name: secondViewName,
        layout: {
          type: "table",
          version: 1,
          columnOrder: [],
          columnPinning: [testWorkspace.filePropertyId],
          filters: [],
          sorts: [],
          hiddenProperties: [],
        },
      }),
    ]);

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        {
          message: "browser context can read the created workspace",
          timeout: 10_000,
        },
      )
      .toBe(200);

    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    const secondTab = page.getByRole("tab", {
      exact: true,
      name: secondViewName,
    });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await expect(secondTab).toBeVisible();

    // Both views into history, ending on the first, so the switch below is a
    // back navigation.
    await secondTab.click();
    await tableTab.click();

    const matchingRow = page.getByRole("button", {
      exact: true,
      name: matchingName,
    });
    const otherRow = page.getByRole("button", { exact: true, name: otherName });
    await expect(matchingRow).toBeVisible({ timeout: 30_000 });
    await expect(otherRow).toBeVisible();

    await page.keyboard.press("ControlOrMeta+f");
    const findInput = page.getByRole("searchbox");
    await expect(findInput).toBeFocused();
    await findInput.fill("alpha");

    // Inside the debounce window on any machine that runs this at all. A slow
    // enough one submits before the switch, which is the correct outcome the
    // assertions below already describe: the test cannot fail spuriously, it
    // can only stop exercising the race.
    await page.goBack({ waitUntil: "commit" });
    await expect(findInput).toBeHidden();

    await page.goForward({ waitUntil: "commit" });
    await expect(
      page.getByRole("button", { exact: true, name: "alpha" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(otherRow).toBeHidden();
    await expect(matchingRow).toBeVisible();

    // The picker's unfolded state is per view for the same reason the term is.
    // Unfold it here, switch, and the other view's bar opens folded.
    const columnsToggle = page.getByRole("button", {
      exact: true,
      name: "Columns to find in",
    });
    // Matched by prefix: the row appends a check mark while its scope is the
    // selected one, so its accessible name is "All columns ✓" here. An exact
    // match would bind to nothing, and the absence assertion below would then
    // pass whatever the picker did.
    const allColumnsRow = page.getByRole("button", { name: /^All columns/u });

    await columnsToggle.click();
    await expect(columnsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(allColumnsRow).toBeVisible();

    await page.goBack({ waitUntil: "commit" });
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByRole("searchbox")).toBeFocused();
    await expect(columnsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(allColumnsRow).toBeHidden();
  });

  // Finding 1 of the find browser test: Folio's find/replace dialog binds
  // Cmd/Ctrl+F on `document` in the bubble phase, unscoped, so one press used
  // to open its dialog on top of whichever bar the registry had awarded the
  // press to. The registry now holds the only listener and stops the press it
  // awards, which is what this asserts — against a stand-in listener of the
  // same shape rather than against Folio, so the guard survives a Folio
  // upgrade and needs no DOCX mounted.
  test("a press the registry awards never reaches a document bubble listener", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const rowName = `alpha-lease-${randomUUID().slice(0, 8)}.docx`;
    await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      { name: rowName, mimeType: DOCX_MIME, buffer: await readFile(DOCX_PATH) },
    );

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        {
          message: "browser context can read the created workspace",
          timeout: 10_000,
        },
      )
      .toBe(200);

    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await tableTab.click();
    await expect(
      page.getByRole("button", { exact: true, name: rowName }),
    ).toBeVisible({ timeout: 30_000 });

    // Records every find press that survives to the document's bubble phase,
    // and whether the app had already claimed it. An attribute rather than a
    // window global so the assertions read it as ordinary page state.
    const body = page.locator("body");
    await page.evaluate(() => {
      document.addEventListener("keydown", (event) => {
        if (
          (!event.metaKey && !event.ctrlKey) ||
          event.key.toLowerCase() !== "f"
        ) {
          return;
        }
        const seen = document.body.dataset["bubbledFindPresses"];
        const entry = event.defaultPrevented ? "prevented" : "untouched";
        document.body.dataset["bubbledFindPresses"] =
          seen === undefined ? entry : `${seen},${entry}`;
      });
    });

    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByRole("searchbox")).toBeFocused();
    await expect(body).not.toHaveAttribute("data-bubbled-find-presses");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox")).toBeHidden();

    // The other half of the contract: with a modal covering the table no
    // surface is reachable, so the press is left alone and the browser's own
    // find still opens.
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox").first()).toBeVisible({
      timeout: 30_000,
    });

    await page.keyboard.press("ControlOrMeta+f");
    await expect(body).toHaveAttribute(
      "data-bubbled-find-presses",
      "untouched",
    );
  });

  // The same contract against the real vendor, which the stand-in above
  // cannot prove: Folio's find binding is bubble-phase today, and an upgrade
  // that moved it to capture would leave the stand-in green while the second
  // bar came back.
  test("a DOCX docked in the inspector adds no second find bar", async ({
    page,
    request,
  }) => {
    test.slow();

    const testWorkspace = workspace;
    if (testWorkspace === null) {
      throw new Error("Test workspace was not created");
    }

    const rowName = `alpha-lease-${randomUUID().slice(0, 8)}.docx`;
    await apiUploadDocx(
      request,
      testWorkspace.id,
      testWorkspace.filePropertyId,
      { name: rowName, mimeType: DOCX_MIME, buffer: await readFile(DOCX_PATH) },
    );

    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);
    await expect
      .poll(
        async () =>
          await apiStatus(page.request, `/workspaces/${testWorkspace.id}`),
        {
          message: "browser context can read the created workspace",
          timeout: 10_000,
        },
      )
      .toBe(200);

    await page.goto(`/workspaces/${testWorkspace.id}/${testWorkspace.viewId}`, {
      waitUntil: "domcontentloaded",
    });

    const tableTab = page.getByRole("tab", { exact: true, name: "Table" });
    await expect(tableTab).toBeVisible({ timeout: 30_000 });
    await tableTab.click();

    const row = page.getByRole("button", { exact: true, name: rowName });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click({ button: "right" });
    const preview = page.getByRole("menuitem", {
      exact: true,
      name: "Preview",
    });
    await expect(preview).toBeVisible();
    await preview.click();

    // Generous: the Folio chunk compiles cold and the DOCX is fetched and
    // parsed before anything paints.
    await expect(
      page.locator(".layout-run-text", {
        hasText: "Stella E2E test document.",
      }),
    ).toBeVisible({ timeout: 45_000 });

    const folioDialog = page.locator(".docx-find-replace-dialog-overlay");

    // The reported repro: nothing focused, so the press falls to the table by
    // precedence while the document pane is on screen.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        active.blur();
      }
    });
    await page.keyboard.press("ControlOrMeta+f");
    await expect(page.getByRole("searchbox").first()).toBeFocused();
    await expect(folioDialog).toHaveCount(0);

    await page.keyboard.press("Escape");

    // The inverse: a press inside the pane opens the document's own bar, and
    // still not Folio's.
    await page.locator('[contenteditable="true"]').first().focus();
    await page.keyboard.press("ControlOrMeta+f");
    await expect(
      page.getByRole("searchbox", { name: "Find text" }),
    ).toBeVisible();
    await expect(folioDialog).toHaveCount(0);
  });
});
