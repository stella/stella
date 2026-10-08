import { describe, expect, test } from "bun:test";

import { createReaderController } from "./controller";
import { createEmbeddedReaderBridge } from "./embedded-bridge";
import type { OpenDecision, ReaderPage } from "./model";

type ParentTransport = Parameters<typeof createEmbeddedReaderBridge>[0];
type ToolResponse = Awaited<ReturnType<ParentTransport["requestTool"]>>;
type ToolRequest = Parameters<ParentTransport["requestTool"]>[0];
const metadata = {
  decisionId: "00000000-0000-4000-8000-000000000001",
  caseNumber: "1 C 1/2026",
  caseNumberType: "case-number",
  courtAbbreviation: null,
  courtTier: "other",
  language: "cs",
  court: "Court",
  country: "CZ",
  date: null,
  ecli: null,
  appUrl: "https://stella.example/decisions/1",
} satisfies ReaderPage["metadata"];
const opened = {
  status: "available",
  metadata,
  outline: [],
  window: [],
  truncated: false,
} satisfies OpenDecision;
const response = (
  structuredContent: OpenDecision | ReaderPage,
): ToolResponse => ({ content: [], structuredContent });
const request = {
  name: "open_case_law_decision",
  arguments: { decision_id: metadata.decisionId, paragraphs: "48-49" },
} as const;
const page = {
  metadata,
  content: {
    status: "available",
    phase: "blocks",
    items: [],
    blockFragments: [],
    citationAnchors: [],
    provisionAnchors: [],
    nextCursor: null,
    limit: 60_000,
  },
} satisfies ReaderPage;
const fixture = () => {
  let context: ReturnType<ParentTransport["getSnapshot"]>["context"] = {
    locale: "cs",
  };
  const listeners = new Set<() => void>();
  const calls: ({ request: ToolRequest } & ReturnType<
    typeof Promise.withResolvers<ToolResponse>
  >)[] = [];
  const hostErrors: NonNullable<
    Parameters<ParentTransport["requestFullscreen"]>[0]
  >[] = [];
  const originalSearch = { status: "ready", search: "unchanged" } as const;
  const parent = {
    getSnapshot: () => ({ context, result: originalSearch }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestTool: async (tool: ToolRequest) => {
      const call = { request: tool, ...Promise.withResolvers<ToolResponse>() };
      calls.push(call);
      return call.promise;
    },
    requestFullscreen: async (
      onError?: Parameters<ParentTransport["requestFullscreen"]>[0],
    ) => {
      if (onError !== undefined) {
        hostErrors.push(onError);
      }
    },
    requestInline: async (
      onError?: Parameters<ParentTransport["requestFullscreen"]>[0],
    ) => {
      if (onError !== undefined) {
        hostErrors.push(onError);
      }
    },
    openLink: async (
      _url: string,
      onError?: Parameters<ParentTransport["requestFullscreen"]>[0],
    ) => {
      if (onError !== undefined) {
        hostErrors.push(onError);
      }
    },
    supportsTools: () => true,
    connect: async () => {},
  } satisfies ParentTransport;
  const session = createEmbeddedReaderBridge(parent);
  const nextCall = () => {
    const call = calls.shift();
    if (call === undefined) {
      throw new TypeError("Expected a pending embedded reader call");
    }
    return call;
  };
  const hostError = () => {
    const fail = hostErrors.shift();
    if (fail === undefined) {
      throw new TypeError("Expected a local host error sink");
    }
    fail(null);
  };
  return {
    session,
    parent,
    calls,
    nextCall,
    hostError,
    setContext: (next: typeof context) => {
      context = next;
      for (const listener of listeners) {
        listener();
      }
    },
    originalSearch,
  };
};

describe("embedded MCP decision reader session", () => {
  test("reader openings use one transport without replacing the results state", async () => {
    const host = fixture();
    const opening = host.session.call(request);
    expect(host.session.getSnapshot().result.status).toBe("loading");
    const call = host.nextCall();
    expect(call.request).toEqual(request);
    call.resolve(response(opened));
    await opening;
    expect(host.session.getSnapshot().result).toEqual({
      status: "ready",
      view: opened,
    });
    expect(host.parent.getSnapshot().result).toBe(host.originalSearch);
    const result = host.session.getSnapshot().result;
    host.setContext({ locale: "de", displayMode: "fullscreen" });
    expect(host.session.getSnapshot().context.locale).toBe("de");
    expect(host.session.getSnapshot().result).toBe(result);
  });
  test("failed opens retry their exact input and stale failures do not replace a newer opening", async () => {
    const host = fixture();
    const failed = host.session.call(request);
    host.nextCall().resolve(undefined);
    await failed;
    expect(host.session.getSnapshot().result.status).toBe("error");
    const retry = host.session.retry();
    const retryCall = host.nextCall();
    expect(retryCall.request).toEqual(request);
    const newer = host.session.call({
      ...request,
      arguments: { decision_id: metadata.decisionId },
    });
    host.nextCall().resolve(response(opened));
    await newer;
    retryCall.resolve(undefined);
    await retry;
    expect(host.session.getSnapshot().result.status).toBe("ready");
    expect(host.parent.getSnapshot().result).toBe(host.originalSearch);
  });
  test("host operation failures stay local and stale host failures after reset are ignored", async () => {
    const host = fixture();
    await host.session.openLink(metadata.appUrl);
    host.hostError();
    expect(host.session.getSnapshot().result.status).toBe("error");
    expect(host.parent.getSnapshot().result).toBe(host.originalSearch);
    await host.session.requestFullscreen();
    host.session.reset();
    host.hostError();
    expect(host.session.getSnapshot().result.status).toBe("idle");
  });
  test("reset discards pending opens and pages while allowing the next reader to open", async () => {
    const host = fixture();
    const controller = createReaderController(host.session);
    const staleOpening = host.session.call(request);
    const staleCall = host.nextCall();
    host.session.reset();
    staleCall.resolve(response(opened));
    await staleOpening;
    expect(host.session.getSnapshot().result.status).toBe("idle");
    expect(controller.getSnapshot().document).toBeNull();
    const opening = host.session.call(request);
    host.nextCall().resolve(response(opened));
    await opening;
    const stalePage = host.nextCall();
    host.session.reset();
    stalePage.resolve(response(page));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().document).toBeNull();
    expect(controller.getSnapshot().requestStatus).toBe("idle");
    const latest = host.session.call(request);
    host.nextCall().resolve(response(opened));
    await latest;
    host.nextCall().resolve(response(page));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.getSnapshot().document?.status).toBe("available");
  });
});
