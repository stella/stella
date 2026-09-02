import type { APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

import { apiGet, apiPut, apiStatus } from "../helpers/api";
import { expect, test } from "../helpers/test";
import {
  type TestWorkspace,
  createTestWorkspace,
  deleteTestWorkspace,
} from "../helpers/workspace";

// Every workspace seeds a "Todos"/"Lists" kanban view alongside its
// overview, table, and files views (apps/api/src/lib/views.ts). Its
// `groupByPropertyId` is the built-in task status, whose declaration order
// (packages/api-contract/src/entity-options.ts: open, in_progress,
// in_review, done, cancelled) is the board's column order, so a plain task
// always lands in the first ("Open") column and the second column is
// always "In progress" — no view or property setup is needed beyond
// creating the workspace and one task.
type ViewSummary = {
  id: string;
  layout: { type: string };
};

type CreatedTask = { entityId: string };

const findKanbanViewId = async (
  request: APIRequestContext,
  workspaceId: string,
): Promise<string> => {
  const views = await apiGet<ViewSummary[]>(request, `/views/${workspaceId}`);
  const kanbanView = views.find((view) => view.layout.type === "kanban");
  if (!kanbanView) {
    throw new Error(
      `workspace ${workspaceId} has no kanban view: ${JSON.stringify(views)}`,
    );
  }
  return kanbanView.id;
};

test.describe("kanban card drag", () => {
  let workspace: TestWorkspace | null = null;

  test.afterEach(async ({ request }) => {
    if (workspace === null) {
      return;
    }
    await deleteTestWorkspace(request, workspace.id);
    workspace = null;
  });

  test("dragging a card into another column moves it there", async ({
    page,
    request,
  }) => {
    test.slow();

    workspace = await createTestWorkspace(request, "kanban-card-drag");
    const testWorkspace = workspace;

    const kanbanViewId = await findKanbanViewId(request, testWorkspace.id);
    const cardName = `kanban-drag-${randomUUID().slice(0, 8)}`;
    await apiPut<CreatedTask>(request, `/tasks/${testWorkspace.id}`, {
      name: cardName,
    });

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

    await page.goto(`/workspaces/${testWorkspace.id}/${kanbanViewId}`, {
      waitUntil: "domcontentloaded",
    });

    const column = (label: string) =>
      page.locator("[data-drag-over]").filter({ hasText: label });

    const openColumn = column("Open");
    const inProgressColumn = column("In progress");
    await expect(openColumn).toBeVisible({ timeout: 30_000 });
    await expect(inProgressColumn).toBeVisible();

    const card = openColumn.getByText(cardName, { exact: true });
    await expect(card).toBeVisible();

    const cardBox = await card.boundingBox();
    const targetBox = await inProgressColumn.boundingBox();
    if (cardBox === null || targetBox === null) {
      throw new Error("Kanban drag geometry is unavailable");
    }

    const sourceX = cardBox.x + cardBox.width / 2;
    const sourceY = cardBox.y + cardBox.height / 2;
    const targetX = targetBox.x + targetBox.width / 2;
    const targetY = targetBox.y + targetBox.height / 2;

    // pragmatic-drag-and-drop's element adapter drives the browser's native
    // HTML5 drag-and-drop (the card element gets `draggable=true`), which
    // only starts once the pointer has moved past a small threshold while
    // pressed. A single coarse jump (as `page.dragAndDrop`/`locator.dragTo`
    // perform) does not reliably cross that threshold or keep the drag
    // "live" long enough for the library's drag-over feedback to fire; a
    // real, multi-step pointer gesture does. Hence: move onto the card,
    // press, nudge a few steps to start the native drag, then step across
    // to the target column and hover before releasing.
    await page.mouse.move(sourceX, sourceY);
    await page.mouse.down();
    await page.mouse.move(sourceX + 10, sourceY + 4, { steps: 5 });
    await page.mouse.move(targetX, targetY, { steps: 20 });

    await expect(inProgressColumn).toHaveAttribute("data-drag-over", "true");

    await page.mouse.up();

    await expect(
      inProgressColumn.getByText(cardName, { exact: true }),
    ).toBeVisible();
    await expect(openColumn.getByText(cardName, { exact: true })).toHaveCount(
      0,
    );
  });
});
