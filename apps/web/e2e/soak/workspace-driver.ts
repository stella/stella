import {
  expect,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
import { panic } from "better-result";

import type { BrowserErrorCollector } from "../helpers/test";
import { WORKSPACE_REPLAY_ENV } from "./env";
import type { ReplayStateSnapshot } from "./replay-artifact";
import {
  HISTORY_DIRECTION,
  WORKSPACE_ACTION_TYPE,
  parseReplayControlSelection,
  type ReplayControlSelection,
  type WeightedWorkspaceAction,
  type WorkspaceAction,
  type WorkspaceActionType,
} from "./workspace-actions";

const ACTION_WEIGHT = {
  [WORKSPACE_ACTION_TYPE.selectControl]: 4,
  [WORKSPACE_ACTION_TYPE.openFixtureDocument]: 5,
  [WORKSPACE_ACTION_TYPE.setInspectorVisibility]: 2,
  [WORKSPACE_ACTION_TYPE.setDocumentDialog]: 2,
  [WORKSPACE_ACTION_TYPE.reload]: 1,
  [WORKSPACE_ACTION_TYPE.navigateHistory]: 1,
} as const satisfies Record<WorkspaceActionType, number>;

type KnownHistory = {
  back: string[];
  forward: string[];
};

export type WorkspaceDriverContext = {
  page: Page;
  browserErrors: BrowserErrorCollector;
  workspaceId: string;
  document: {
    entityId: string;
    fieldId: string;
    fileName: string;
  };
  history: KnownHistory;
  httpFailures: HttpFailureCollector;
};

type HttpFailure = {
  method: string;
  pathname: string;
  status: number;
};

export type HttpFailureCollector = {
  entries: () => readonly HttpFailure[];
  dispose: () => void;
};

/** Track only method, path and status; never retain query strings or bodies. */
export const trackApiFailures = (page: Page): HttpFailureCollector => {
  const apiOrigin = new URL(WORKSPACE_REPLAY_ENV.apiUrl).origin;
  const failures: HttpFailure[] = [];
  const onResponse = (response: Response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (url.origin !== apiOrigin || response.status() < 400) {
      return;
    }
    failures.push({
      method: request.method(),
      pathname: url.pathname,
      status: response.status(),
    });
  };
  page.on("response", onResponse);
  return {
    entries: () => failures.slice(),
    dispose: () => {
      page.off("response", onResponse);
    },
  };
};

const visible = async (locator: Locator) => await locator.isVisible();

const routeTemplate = (page: Page): string => {
  const { pathname } = new URL(page.url());
  if (/^\/workspaces\/[^/]+\/[^/]+\/document$/u.test(pathname)) {
    return "/workspaces/:workspaceId/:viewId/document";
  }
  if (/^\/workspaces\/[^/]+\/[^/]+$/u.test(pathname)) {
    return "/workspaces/:workspaceId/:viewId";
  }
  if (/^\/workspaces\/[^/]+$/u.test(pathname)) {
    return "/workspaces/:workspaceId";
  }
  return pathname;
};

type SelectableControl = {
  selection: ReplayControlSelection;
  locator: Locator;
  activate: () => Promise<void>;
  disabled: boolean;
  selectedAttribute: {
    name: string;
    value: string;
  };
};

const selectableControl = ({
  family,
  key,
  locator,
  activate,
  disabled = false,
  selectedAttribute,
}: {
  family: string;
  key: string;
  locator: Locator;
  activate?: () => Promise<void>;
  disabled?: boolean;
  selectedAttribute: SelectableControl["selectedAttribute"];
}): SelectableControl => ({
  selection: parseReplayControlSelection({ family, key }),
  locator,
  activate: activate ?? (async () => await locator.click()),
  disabled,
  selectedAttribute,
});

const discoverWorkspaceViews = async (page: Page) => {
  const tabs = await page
    .locator('[data-slot="workspace-view-switcher"]')
    .getByRole("tab")
    .all();
  const controls: SelectableControl[] = [];
  for (const [index, tab] of tabs.entries()) {
    if (await visible(tab)) {
      controls.push(
        selectableControl({
          family: "workspace-view",
          key: String(index),
          locator: tab,
          selectedAttribute: { name: "aria-selected", value: "true" },
        }),
      );
    }
  }
  return controls;
};

const discoverInspectorFacets = async (page: Page) => {
  const facetBar = page.locator('[data-slot="inspector-facet-bar"]:visible');
  if (!(await visible(facetBar))) {
    return [];
  }
  const optionMarkers = await facetBar.locator("[data-facet-option]").all();
  const controls: SelectableControl[] = [];
  for (const optionMarker of optionMarkers) {
    const key = await optionMarker.getAttribute("data-facet-option");
    if (key !== null) {
      controls.push(
        selectableControl({
          family: "inspector-facet",
          key,
          locator: facetBar,
          activate: async () => {
            const chips = await facetBar
              .locator("[data-facet-value]:visible")
              .all();
            for (const chip of chips) {
              if ((await chip.getAttribute("data-facet-value")) === key) {
                await chip.click();
                return;
              }
            }

            await facetBar
              .locator(
                '[data-slot="inspector-facet-overflow-trigger"]:visible',
              )
              .click();
            const overflowItems = await page
              .locator("[data-facet-overflow-value]:visible")
              .all();
            for (const item of overflowItems) {
              if (
                (await item.getAttribute("data-facet-overflow-value")) === key
              ) {
                await item.click();
                return;
              }
            }
            throw new Error(`Inspector facet is unavailable: ${key}`);
          },
          disabled:
            (await optionMarker.getAttribute(
              "data-facet-option-disabled",
            )) !== null,
          selectedAttribute: {
            name: "data-active-facet",
            value: key,
          },
        }),
      );
    }
  }
  return controls;
};

const discoverToolbarControls = async (page: Page) => {
  const groups = await page
    .locator(
      '[data-slot="workspace-view-toolbar"] [data-slot="segmented-icon-toggle"]:visible',
    )
    .all();
  const controls: SelectableControl[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const options = await group.locator("[data-control-value]:visible").all();
    for (const option of options) {
      const key = await option.getAttribute("data-control-value");
      if (key !== null) {
        controls.push(
          selectableControl({
            family: `workspace-toolbar-${String(groupIndex)}`,
            key,
            locator: option,
            selectedAttribute: { name: "aria-pressed", value: "true" },
          }),
        );
      }
    }
  }
  return controls;
};

const discoverSelectableControls = async (
  page: Page,
): Promise<SelectableControl[]> => {
  const controls = [
    ...(await discoverWorkspaceViews(page)),
    ...(await discoverInspectorFacets(page)),
    ...(await discoverToolbarControls(page)),
  ];
  const keys = controls.map(({ selection }) => JSON.stringify(selection));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Selectable controls must have unique family/key pairs");
  }
  return controls;
};

const controlIsSelected = async ({
  locator,
  selectedAttribute,
}: SelectableControl) =>
  (await locator.getAttribute(selectedAttribute.name)) ===
  selectedAttribute.value;

const selectedControls = async (
  page: Page,
): Promise<ReplayControlSelection[]> => {
  const selected: ReplayControlSelection[] = [];
  for (const control of await discoverSelectableControls(page)) {
    if (await controlIsSelected(control)) {
      selected.push(control.selection);
    }
  }
  return selected;
};

const documentIsLoaded = ({ document, page }: WorkspaceDriverContext) => {
  const url = new URL(page.url());
  return (
    url.searchParams.get("entity") === document.entityId &&
    url.searchParams.get("field") === document.fieldId
  );
};

export const readWorkspaceState = async (
  context: WorkspaceDriverContext,
): Promise<ReplayStateSnapshot> => {
  const { page } = context;
  const dock = page.locator('[data-slot="inspector-dock"]');
  const dockState = await dock.getAttribute("data-state");
  let inspectorVisible: boolean | undefined;
  if (dockState === "expanded") {
    inspectorVisible = true;
  } else if (dockState === "collapsed") {
    inspectorVisible = false;
  }

  return {
    route: routeTemplate(page),
    selectedControls: await selectedControls(page),
    ...(inspectorVisible === undefined ? {} : { inspectorVisible }),
    documentDialogOpen: await visible(
      page.getByRole("dialog", { name: "Translate document" }),
    ),
    ...(documentIsLoaded(context) ? { loadedDocumentKey: "primary" } : {}),
  };
};

const addCandidate = (
  candidates: WeightedWorkspaceAction[],
  action: WorkspaceAction,
) => {
  candidates.push({ action, weight: ACTION_WEIGHT[action.type] });
};

export const availableWorkspaceActions = async (
  context: WorkspaceDriverContext,
): Promise<WeightedWorkspaceAction[]> => {
  const { page } = context;
  const candidates: WeightedWorkspaceAction[] = [];
  const dialog = page.getByRole("dialog", { name: "Translate document" });

  if (await visible(dialog)) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.setDocumentDialog,
      open: false,
    });
    return candidates;
  }

  for (const control of await discoverSelectableControls(page)) {
    if (!control.disabled && !(await controlIsSelected(control))) {
      addCandidate(candidates, {
        type: WORKSPACE_ACTION_TYPE.selectControl,
        control: control.selection,
      });
    }
  }

  const fileButton = page.getByRole("button", {
    exact: true,
    name: context.document.fileName,
  });
  if ((await visible(fileButton)) && !documentIsLoaded(context)) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.openFixtureDocument,
      documentKey: "primary",
    });
  }
  if (await visible(fileButton)) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.setDocumentDialog,
      open: true,
    });
  }

  const inspectorDock = page.locator('[data-slot="inspector-dock"]');
  if (
    await visible(
      inspectorDock.getByRole("button", { exact: true, name: "Hide pane" }),
    )
  ) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.setInspectorVisibility,
      visible: false,
    });
  }
  if (
    await visible(
      inspectorDock.getByRole("button", { exact: true, name: "Show pane" }),
    )
  ) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.setInspectorVisibility,
      visible: true,
    });
  }

  if (context.history.back.length > 0) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.navigateHistory,
      direction: HISTORY_DIRECTION.back,
    });
  }
  if (context.history.forward.length > 0) {
    addCandidate(candidates, {
      type: WORKSPACE_ACTION_TYPE.navigateHistory,
      direction: HISTORY_DIRECTION.forward,
    });
  }

  addCandidate(candidates, { type: WORKSPACE_ACTION_TYPE.reload });
  return candidates;
};

const recordNavigation = (
  context: WorkspaceDriverContext,
  previousUrl: string,
) => {
  if (context.page.url() === previousUrl) {
    return;
  }
  context.history.back.push(previousUrl);
  context.history.forward.length = 0;
};

const executeHistoryAction = async (
  context: WorkspaceDriverContext,
  direction: "back" | "forward",
) => {
  const { page } = context;
  const currentUrl = page.url();
  const source =
    direction === HISTORY_DIRECTION.back
      ? context.history.back
      : context.history.forward;
  const destination =
    direction === HISTORY_DIRECTION.back
      ? context.history.forward
      : context.history.back;
  const expectedUrl = source.at(-1);
  if (expectedUrl === undefined) {
    throw new Error(`No known ${direction} history entry`);
  }

  if (direction === HISTORY_DIRECTION.back) {
    await page.goBack({ waitUntil: "domcontentloaded" });
  } else {
    await page.goForward({ waitUntil: "domcontentloaded" });
  }
  await page.waitForURL(expectedUrl);
  source.pop();
  destination.push(currentUrl);
};

export const executeWorkspaceAction = async (
  context: WorkspaceDriverContext,
  action: WorkspaceAction,
): Promise<void> => {
  const { page } = context;
  switch (action.type) {
    case WORKSPACE_ACTION_TYPE.selectControl: {
      const previousUrl = page.url();
      const controls = await discoverSelectableControls(page);
      const control = controls.find(
        ({ selection }) =>
          selection.family === action.control.family &&
          selection.key === action.control.key,
      );
      if (control === undefined) {
        throw new Error(
          `Selectable control is unavailable: ${action.control.family}/${action.control.key}`,
        );
      }
      await control.activate();
      await expect(control.locator).toHaveAttribute(
        control.selectedAttribute.name,
        control.selectedAttribute.value,
      );
      recordNavigation(context, previousUrl);
      return;
    }
    case WORKSPACE_ACTION_TYPE.openFixtureDocument: {
      const previousUrl = page.url();
      await page
        .getByRole("button", {
          exact: true,
          name: context.document.fileName,
        })
        .click();
      await expect(
        page.getByRole("toolbar", { name: "AI message composer" }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(
        page.locator(".layout-run-text", {
          hasText: "Stella E2E test document.",
        }),
      ).toBeVisible({ timeout: 45_000 });
      recordNavigation(context, previousUrl);
      return;
    }
    case WORKSPACE_ACTION_TYPE.setInspectorVisibility: {
      const sourceName = action.visible ? "Show pane" : "Hide pane";
      const destinationName = action.visible ? "Hide pane" : "Show pane";
      const inspectorDock = page.locator('[data-slot="inspector-dock"]');
      await inspectorDock
        .getByRole("button", { exact: true, name: sourceName })
        .click();
      await expect(
        inspectorDock.getByRole("button", {
          exact: true,
          name: destinationName,
        }),
      ).toBeVisible();
      return;
    }
    case WORKSPACE_ACTION_TYPE.setDocumentDialog:
      if (action.open) {
        await page
          .getByRole("button", {
            exact: true,
            name: context.document.fileName,
          })
          .click({ button: "right" });
        const translate = page.getByRole("menuitem", {
          exact: true,
          name: "Translate",
        });
        await expect(translate).toBeVisible();
        await translate.click();
        await expect(
          page.getByRole("dialog", { name: "Translate document" }),
        ).toBeVisible();
      } else {
        const dialog = page.getByRole("dialog", {
          name: "Translate document",
        });
        await dialog
          .getByRole("button", { exact: true, name: "Close" })
          .click();
        await expect(dialog).toBeHidden();
      }
      return;
    case WORKSPACE_ACTION_TYPE.reload: {
      const before = await readWorkspaceState(context);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(async () => await readWorkspaceState(context), {
          message: "reload restores the same structural workspace state",
          timeout: 45_000,
        })
        .toEqual(before);
      return;
    }
    case WORKSPACE_ACTION_TYPE.navigateHistory:
      await executeHistoryAction(context, action.direction);
      return;
    default:
      action satisfies never;
      return panic(`Unhandled workspace action: ${String(action)}`);
  }
};

export const assertWorkspaceInvariants = async (
  context: WorkspaceDriverContext,
): Promise<void> => {
  const { page } = context;
  const url = new URL(page.url());
  const workspacePath = `/workspaces/${context.workspaceId}`;
  expect(
    url.pathname === workspacePath ||
      url.pathname.startsWith(`${workspacePath}/`),
    "soak action escaped the synthetic matter",
  ).toBe(true);
  await expect(
    page.locator('[data-slot="inspector-dock"]'),
    "synthetic matter exposes the inspector dock",
  ).toBeVisible();
  expect(
    url.pathname,
    "soak action reached an authentication route",
  ).not.toMatch(/^\/auth(?:\/|$)/u);
  await expect(page.locator('[data-slot="sidebar"]')).toBeVisible();

  const visibleDialogs = await page.locator('[role="dialog"]:visible').count();
  expect(
    visibleDialogs,
    "workspace explorer allows at most one blocking dialog",
  ).toBeLessThanOrEqual(1);

  expect(
    context.browserErrors.entries(),
    "workspace explorer observed a browser error",
  ).toEqual([]);
  expect(
    context.httpFailures.entries(),
    "workspace explorer observed a failed API response",
  ).toEqual([]);

  const entityId = url.searchParams.get("entity");
  const fieldId = url.searchParams.get("field");
  if (entityId !== null || fieldId !== null) {
    expect(entityId, "document route belongs to the fixture entity").toBe(
      context.document.entityId,
    );
    expect(fieldId, "document route belongs to the fixture field").toBe(
      context.document.fieldId,
    );
  }

  const state = await readWorkspaceState(context);
  const selectedFamilies = state.selectedControls.map(({ family }) => family);
  expect(
    new Set(selectedFamilies).size,
    "each selectable control family has at most one active value",
  ).toBe(selectedFamilies.length);
  if (state.inspectorVisible === true) {
    await expect(page.locator('[data-slot="inspector-dock"]')).toHaveAttribute(
      "data-state",
      "expanded",
    );
    await expect(page.locator('[data-slot="inspector"]')).toBeVisible();
  }
};
