import { afterEach, expect, mock, test } from "bun:test";

import {
  CASE_DECISION_PLACEMENT,
  createCaseDecisionViewTab,
} from "./case-decision-view";
import { useInspectorTabsStore } from "./inspector-tabs-store";
import {
  mainDecisionReaderStore,
  registerMainDecisionReader,
} from "./main-decision-reader";

const target = (decisionId: string, anchorId = "p-12") =>
  createCaseDecisionViewTab({
    decisionId,
    anchorId,
    caseNumber: "1 As 12/2024",
    country: "CZE",
    court: "Nejvyšší správní soud",
    language: "cs",
    languageAlternates: null,
    slug: "decision",
  });

afterEach(() => {
  mainDecisionReaderStore.setState({ reader: null });
  useInspectorTabsStore.setState({ tabs: [], activeId: null, minimized: true });
});

test("opening the main decision navigates its passage without touching inspector state", () => {
  const openPassage = mock(() => {});
  registerMainDecisionReader({ decisionId: "main", openPassage });
  useInspectorTabsStore.setState({ tabs: [], activeId: null, minimized: true });
  const before = useInspectorTabsStore.getState();
  const tab = target("main");
  before.openView(tab);
  expect(openPassage).toHaveBeenCalledWith(tab.payload);
  expect(useInspectorTabsStore.getState()).toBe(before);
});

test("an existing decision chip is focused and receives the new passage by identity", () => {
  registerMainDecisionReader({
    decisionId: "main",
    openPassage: mock(() => {}),
  });
  const store = useInspectorTabsStore.getState();
  store.openView(target("other"));
  store.openView({
    ...target("other", "p-20"),
    label: "Different label",
    payload: {
      ...target("other", "p-20").payload,
      route: { country: "cz", court: "nss", slug: "alternate" },
    },
  });
  const { tabs, activeId } = useInspectorTabsStore.getState();
  expect(tabs).toHaveLength(1);
  expect(activeId).toBe(target("other").id);
  expect(tabs.at(0)).toMatchObject({ payload: { anchorId: "p-20" } });
});

test("a different decision opens a new chip", () => {
  registerMainDecisionReader({
    decisionId: "main",
    openPassage: mock(() => {}),
  });
  useInspectorTabsStore.getState().openView(target("other"));
  expect(useInspectorTabsStore.getState().tabs).toHaveLength(1);
  expect(useInspectorTabsStore.getState().minimized).toBe(false);
});

test("a stale reader cleanup cannot unregister its successor", () => {
  const release = registerMainDecisionReader({
    decisionId: "old",
    openPassage: mock(() => {}),
  });
  registerMainDecisionReader({
    decisionId: "new",
    openPassage: mock(() => {}),
  });
  release();
  expect(mainDecisionReaderStore.getState().reader?.decisionId).toBe("new");
});

test("explicit docking can move the main decision into the side panel", () => {
  const openPassage = mock(() => {});
  registerMainDecisionReader({ decisionId: "main", openPassage });
  useInspectorTabsStore.getState().openView({
    ...target("main"),
    decisionPlacement: CASE_DECISION_PLACEMENT.side,
  });
  expect(openPassage).not.toHaveBeenCalled();
  expect(useInspectorTabsStore.getState().tabs).toHaveLength(1);
});

test("the main decision wins over an existing side chip and repeated clicks dispatch again", () => {
  useInspectorTabsStore.getState().openView(target("main"));
  const openPassage = mock(() => {});
  registerMainDecisionReader({ decisionId: "main", openPassage });
  const before = useInspectorTabsStore.getState();
  before.openView(target("main"));
  before.openView(target("main"));
  expect(openPassage).toHaveBeenCalledTimes(2);
  expect(useInspectorTabsStore.getState()).toBe(before);
});

test("the shared opener derives chip identity from the decision rather than caller labels or ids", () => {
  const store = useInspectorTabsStore.getState();
  store.openView({ ...target("other"), id: "first-url" });
  store.openView({ ...target("other", "p-20"), id: "second-url" });
  expect(useInspectorTabsStore.getState().tabs).toHaveLength(1);
  expect(useInspectorTabsStore.getState().activeId).toBe(target("other").id);
});
