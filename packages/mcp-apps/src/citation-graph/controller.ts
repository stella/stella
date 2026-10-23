import * as v from "valibot";

import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";

import type { createPresentationBridge } from "../shared/bridge";
import { APP_OPEN_DECISION_SCHEMA } from "../shared/generated/contracts";
import { canExpand, createGraph, mergePage } from "./model";
import type { GraphModel } from "./model";
import { parseCitationPage } from "./parse";
import type { CitationPage } from "./parse";

type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string | null };
type GraphSnapshot = { model: GraphModel | null; request: RequestState };
type GraphBridge = Pick<
  ReturnType<typeof createPresentationBridge<CitationPage>>,
  "subscribe" | "getSnapshot" | "supportsTools" | "requestTool" | "openLink"
>;

export const createGraphController = (bridge: GraphBridge) => {
  const listeners = new Set<() => void>();
  let generation = 0;
  let received: unknown;
  let snapshot: GraphSnapshot = { model: null, request: { status: "idle" } };
  const publish = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  bridge.subscribe(() => {
    const { result } = bridge.getSnapshot();
    switch (result.status) {
      case "idle":
      case "loading":
      case "error":
        generation += 1;
        received = undefined;
        snapshot = { model: null, request: { status: "idle" } };
        break;
      case "ready":
        if (received !== result.view) {
          generation += 1;
          received = result.view;
          snapshot = {
            model: createGraph(result.view),
            request: { status: "idle" },
          };
        }
        break;
    }
    publish();
  });
  const fail = (message: string | null) => {
    snapshot = { model: snapshot.model, request: { status: "error", message } };
    publish();
  };
  const read = async (decisionId: string) => {
    const model = snapshot.model;
    if (
      model === null ||
      snapshot.request.status === "loading" ||
      !bridge.supportsTools()
    ) {
      return;
    }
    const page = model.pages.find((entry) => entry.decisionId === decisionId);
    if (page === undefined && !canExpand(model, decisionId)) {
      return;
    }
    if (page?.nextCursor === null) {
      return;
    }
    const current = generation;
    snapshot = { model, request: { status: "loading" } };
    publish();
    const result = await bridge.requestTool({
      name: "read_case_law_citations",
      arguments: {
        decision_id: decisionId,
        direction: model.direction,
        ...(model.doctrine === undefined ? {} : { doctrine: model.doctrine }),
        ...(model.polarity === undefined ? {} : { polarity: model.polarity }),
        ...(page === undefined ? {} : { cursor: page.nextCursor }),
      },
    });
    if (generation !== current) {
      return;
    }
    const parsed =
      result?.isError === true
        ? undefined
        : parseCitationPage(result?.structuredContent);
    if (
      parsed === undefined ||
      parsed.decisionId !== decisionId ||
      parsed.direction !== model.direction ||
      (page !== undefined &&
        parsed.nextCursor !== null &&
        parsed.nextCursor === page.nextCursor)
    ) {
      fail(result?.content.find((part) => part.type === "text")?.text ?? null);
      return;
    }
    snapshot = { model: mergePage(model, parsed), request: { status: "idle" } };
    publish();
  };
  const open = async (decisionId: string, readerUrl: string | null) => {
    if (snapshot.model === null || snapshot.request.status === "loading") {
      return;
    }
    if (!bridge.supportsTools() && readerUrl === null) {
      return;
    }
    const current = generation;
    snapshot = { model: snapshot.model, request: { status: "loading" } };
    publish();
    const onError = (message: string | null) => {
      if (generation === current) {
        fail(message);
      }
    };
    if (!bridge.supportsTools()) {
      if (readerUrl !== null) {
        await bridge.openLink(readerUrl, onError);
      }
      if (generation === current && snapshot.request.status === "loading") {
        snapshot = { model: snapshot.model, request: { status: "idle" } };
        publish();
      }
      return;
    }
    const result = await bridge.requestTool({
      name: "open_case_law_decision",
      arguments: { decision_id: decisionId },
    });
    if (result === undefined || result.isError === true) {
      onError(
        result?.content.find((part) => part.type === "text")?.text ?? null,
      );
      return;
    }
    if (generation !== current) {
      return;
    }
    const parsed = v.safeParse(
      APP_OPEN_DECISION_SCHEMA,
      result.structuredContent,
    );
    const url = parsed.success
      ? parseLegalCitationHttpUrl(parsed.output.metadata.url)
      : null;
    if (
      !parsed.success ||
      parsed.output.metadata.decisionId !== decisionId ||
      url === null
    ) {
      onError(null);
      return;
    }
    await bridge.openLink(url.href, onError);
    if (generation !== current || snapshot.request.status !== "loading") {
      return;
    }
    snapshot = { model: snapshot.model, request: { status: "idle" } };
    publish();
  };
  return {
    read,
    open,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
