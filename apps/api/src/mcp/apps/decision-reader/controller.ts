import { parseDecisionParagraphFragment } from "@stll/api-contract/decision-paragraph-range";

import { DECISION_READER_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import {
  appendReaderPage,
  createReaderPager,
  parseOpenDecision,
  parseProvisionPreview,
  parseReaderPage,
  resolveReaderRange,
} from "./model";
import type { OpenDecision, ProvisionPreview, ReaderPager } from "./model";

type ReaderControllerSnapshot = {
  document: ReaderPager | null;
  requestStatus: "idle" | "loading" | "error";
  previewStatus: "idle" | "loading" | "error";
  preview: ProvisionPreview | null;
};
const createReaderSnapshot = (): ReaderControllerSnapshot => ({
  document: null,
  requestStatus: "idle",
  previewStatus: "idle",
  preview: null,
});

export const createReaderController = (
  bridge = createPresentationBridge({
    manifest: DECISION_READER_APP,
    parse: parseOpenDecision,
  }),
) => {
  const listeners = new Set<() => void>();
  let generation = 0;
  let previewGeneration = 0;
  let received: OpenDecision | undefined;
  let lastProvision:
    | ReaderPager["provisionAnchors"][number]["provision"]
    | undefined;
  let snapshot = createReaderSnapshot();
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const range = () => {
    const url = received?.metadata.appUrl;
    return url === null || url === undefined || !URL.canParse(url)
      ? null
      : parseDecisionParagraphFragment(new URL(url).hash);
  };
  const loadNext = async () => {
    const document = snapshot.document;
    if (
      document === null ||
      document.complete ||
      snapshot.requestStatus === "loading"
    ) {
      return;
    }
    const current = generation;
    snapshot = { ...snapshot, requestStatus: "loading" };
    publish();
    const cursor = document.nextCursor;
    const result = await bridge.requestTool({
      name: "read_case_law_decision_blocks",
      arguments: {
        decision_id: document.metadata.decisionId,
        ...(cursor === null ? {} : { cursor }),
      },
    });
    if (current !== generation) {
      return;
    }
    const page =
      result === undefined
        ? undefined
        : parseReaderPage(result.structuredContent);
    const appended =
      page === undefined
        ? undefined
        : appendReaderPage({ state: document, page, cursor });
    if (appended === undefined || appended.status === "invalid") {
      snapshot = { ...snapshot, requestStatus: "error" };
      publish();
      return;
    }
    snapshot = {
      ...snapshot,
      document: appended.state,
      requestStatus: "idle",
    };
    publish();
    const target = range();
    if (
      target !== null &&
      !appended.state.complete &&
      resolveReaderRange(appended.state, target).type === "not-found"
    ) {
      await loadNext();
    }
  };
  const loadPreview = async (
    provision: ReaderPager["provisionAnchors"][number]["provision"],
  ) => {
    lastProvision = provision;
    const current = generation;
    const currentPreview = ++previewGeneration;
    snapshot = { ...snapshot, previewStatus: "loading" };
    publish();
    const result = await bridge.requestTool({
      name: "preview_cited_provision",
      arguments: { provision },
    });
    if (current !== generation || currentPreview !== previewGeneration) {
      return;
    }
    const preview =
      result === undefined
        ? undefined
        : parseProvisionPreview(result.structuredContent);
    snapshot = {
      ...snapshot,
      preview: preview ?? null,
      previewStatus: preview === undefined ? "error" : "idle",
    };
    publish();
  };
  const retry = async () => {
    if (snapshot.requestStatus === "error") {
      await loadNext();
      return;
    }
    if (snapshot.previewStatus === "error" && lastProvision !== undefined) {
      await loadPreview(lastProvision);
      return;
    }
    await bridge.retry();
  };
  const dismiss = () => {
    generation += 1;
    previewGeneration += 1;
    received = undefined;
    lastProvision = undefined;
    snapshot = createReaderSnapshot();
    publish();
  };
  bridge.subscribe(() => {
    const result = bridge.getSnapshot().result;
    if (result.status === "idle") {
      dismiss();
      return;
    }
    if (result.status === "loading") {
      dismiss();
      return;
    }
    if (result.status !== "ready" || result.view === received) {
      publish();
      return;
    }
    received = result.view;
    lastProvision = undefined;
    generation += 1;
    previewGeneration += 1;
    snapshot = {
      ...createReaderSnapshot(),
      document:
        received.status === "unavailable"
          ? null
          : createReaderPager(received.metadata),
    };
    publish();
    bridge.detached(bridge.requestFullscreen(), "request reader display mode");
    if (received.status !== "unavailable") {
      bridge.detached(loadNext(), "load decision blocks");
    }
  });
  return {
    bridge,
    loadNext,
    range,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadPreview,
    retry,
  };
};
export type ReaderController = ReturnType<typeof createReaderController>;
