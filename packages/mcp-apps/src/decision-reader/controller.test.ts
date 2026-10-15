import { describe, expect, test } from "bun:test";

import { createDetached } from "@stll/errors";
import type { ParagraphBlock } from "@stll/legal-ast/document-ast";

import type { ProvisionPreview } from "../shared/generated/contracts";
import { createReaderController } from "./controller";
import type { OpenDecision, ReaderPage } from "./model";

type ReaderBridge = NonNullable<Parameters<typeof createReaderController>[0]>;
type ToolRequest = Parameters<ReaderBridge["requestTool"]>[0];
type ToolResponse = Awaited<ReturnType<ReaderBridge["requestTool"]>>;
type BridgeSnapshot = ReturnType<ReaderBridge["getSnapshot"]>;

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
const paragraph = (number: number) =>
  ({
    id: `block-${number}`,
    anchorId: `publisher-${number}`,
    type: "paragraph",
    number,
    inlines: [{ type: "text", text: `Paragraph ${number}` }],
    plainText: `Paragraph ${number}`,
  }) satisfies ParagraphBlock;
const open = (value = metadata): OpenDecision => ({
  status: "available",
  metadata: value,
  outline: [],
  window: [],
  truncated: false,
});
const withheld = (): OpenDecision => ({
  status: "withheld",
  metadata,
  withheldReason: { code: "source_licence", message: "Open in stella" },
});
const page = (
  number: number,
  nextCursor: string | null = null,
): ReaderPage => ({
  metadata,
  content: {
    status: "available",
    phase: "blocks",
    items: [paragraph(number)],
    blockFragments: [],
    citationAnchors: [],
    provisionAnchors: [],
    nextCursor,
    limit: 60_000,
  },
});
const response = (
  structuredContent: ReaderPage | ProvisionPreview,
): ToolResponse => ({ content: [], structuredContent });
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const fixture = () => {
  let snapshot: BridgeSnapshot = {
    context: {},
    input: {},
    tool: "open_case_law_decision",
    result: { status: "idle" },
  };
  const listeners = new Set<() => void>();
  const calls: ({ request: ToolRequest } & ReturnType<
    typeof Promise.withResolvers<ToolResponse>
  >)[] = [];
  const failures: unknown[] = [];
  let fullscreenRequests = 0;
  let openingRetries = 0;
  const bridge = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestTool: async (request: ToolRequest) => {
      const call = { request, ...Promise.withResolvers<ToolResponse>() };
      calls.push(call);
      return call.promise;
    },
    requestFullscreen: async () => {
      fullscreenRequests += 1;
    },
    detached: createDetached((error) => {
      failures.push(error);
    }),
    requestInline: async () => {},
    connect: async () => {},
    supportsTools: () => true,
    call: async () => {},
    openLink: async () => {},
    retry: async () => {
      openingRetries += 1;
    },
  } satisfies ReaderBridge;
  const controller = createReaderController(bridge);
  const emit = (result: BridgeSnapshot["result"]) => {
    snapshot = { ...snapshot, result };
    for (const listener of listeners) {
      listener();
    }
  };
  const nextCall = () => {
    const call = calls.shift();
    if (call === undefined) {
      throw new TypeError("Expected a pending reader tool call");
    }
    return call;
  };
  return {
    controller,
    emit,
    calls,
    nextCall,
    failures,
    fullscreenRequests: () => fullscreenRequests,
    openingRetries: () => openingRetries,
  };
};

describe("MCP decision reader controller", () => {
  test("restricted open metadata loads full app-only text under source mode A", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: withheld() });
    expect(host.fullscreenRequests()).toBe(1);
    const call = host.nextCall();
    expect(call.request).toEqual({
      name: "read_case_law_decision_blocks",
      arguments: { decision_id: metadata.decisionId },
    });
    call.resolve(response(page(48)));
    await settle();
    expect(host.controller.getSnapshot().document?.status).toBe("available");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
    ]);
    expect(host.failures).toEqual([]);
  });
  test("restricted source mode B keeps metadata and excludes body text", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: withheld() });
    host.nextCall().resolve(
      response({
        metadata,
        content: {
          status: "withheld",
          withheldReason: {
            code: "source_licence",
            message: "Open in stella",
          },
        },
      }),
    );
    await settle();
    expect(host.controller.getSnapshot().document?.status).toBe("withheld");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([]);
    expect(host.controller.getSnapshot().document?.complete).toBe(true);
    await host.controller.loadNext();
    expect(host.calls).toHaveLength(0);
  });
  test("range opening loads pages until all requested court paragraphs arrive", async () => {
    const host = fixture();
    host.emit({
      status: "ready",
      view: open({ ...metadata, appUrl: `${metadata.appUrl}#par=48-49` }),
    });
    host.nextCall().resolve(response(page(47, "page-2")));
    await settle();
    const second = host.nextCall();
    expect(second.request.arguments["cursor"]).toBe("page-2");
    second.resolve(response(page(48, "page-3")));
    await settle();
    const third = host.nextCall();
    expect(third.request.arguments["cursor"]).toBe("page-3");
    third.resolve(response(page(49, "page-4")));
    await settle();
    expect(host.controller.range()).toEqual({ from: 48, to: 49 });
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(47),
      paragraph(48),
      paragraph(49),
    ]);
    expect(host.controller.getSnapshot().document?.nextCursor).toBe("page-4");
    expect(host.calls).toHaveLength(0);
  });
  test("a new open invalidates pending pages before its result arrives", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    const stale = host.nextCall();
    host.emit({ status: "loading" });
    stale.resolve(response(page(48)));
    await settle();
    expect(host.controller.getSnapshot().document).toBeNull();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(49)));
    await settle();
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(49),
    ]);
  });
  test("failed pages preserve their cursor and loaded blocks for retry", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(48, "page-2")));
    await settle();
    const failedLoad = host.controller.loadNext();
    host.nextCall().resolve(undefined);
    await failedLoad;
    expect(host.controller.getSnapshot().requestStatus).toBe("error");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
    ]);
    const retry = host.controller.retry();
    const call = host.nextCall();
    expect(call.request.arguments["cursor"]).toBe("page-2");
    call.resolve(response(page(49)));
    await retry;
    expect(host.controller.getSnapshot().requestStatus).toBe("idle");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
      paragraph(49),
    ]);
  });
  test("a conflicted continuation restarts revised pages and preserves the paragraph range", async () => {
    const host = fixture();
    host.emit({
      status: "ready",
      view: open({ ...metadata, appUrl: `${metadata.appUrl}#par=48-49` }),
    });
    host.nextCall().resolve(response(page(48, "old-page-2")));
    await settle();
    const continuation = host.nextCall();
    expect(continuation.request.arguments["cursor"]).toBe("old-page-2");
    const pendingPreview = host.controller.loadPreview({
      document_id: metadata.decisionId,
      anchor: "par-1",
    });
    const previewCall = host.nextCall();
    continuation.resolve({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "conflict",
              message: "Decision text changed between pages.",
              hint: "Restart the decision read without a cursor.",
              retryable: true,
            },
          }),
        },
      ],
    } satisfies NonNullable<ToolResponse>);
    await settle();
    expect(host.controller.getSnapshot().requestStatus).toBe("conflict");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([]);
    expect(host.controller.getSnapshot().document?.nextCursor).toBeNull();
    expect(host.controller.getSnapshot().preview).toBeNull();
    await host.controller.loadNext();
    expect(host.calls).toHaveLength(0);
    const retry = host.controller.retry();
    const restarted = host.nextCall();
    expect(restarted.request.arguments).toEqual({
      decision_id: metadata.decisionId,
    });
    expect(host.controller.getSnapshot().document?.blocks).toEqual([]);
    expect(host.controller.getSnapshot().document?.seenCursors).toEqual([]);
    expect(host.controller.getSnapshot().document?.citationAnchors).toEqual([]);
    expect(host.controller.getSnapshot().document?.provisionAnchors).toEqual(
      [],
    );
    expect(host.controller.getSnapshot().document?.pendingFragment).toBeNull();
    expect(host.controller.range()).toEqual({ from: 48, to: 49 });
    previewCall.resolve(
      response({
        appUrl: null,
        documentId: metadata.decisionId,
        language: "cs",
        anchorId: "par-1",
        citedAnchorId: null,
        headings: [],
        heading: null,
        blocks: [],
      }),
    );
    await pendingPreview;
    expect(host.controller.getSnapshot().preview).toBeNull();
    const revised = page(48, "revised-page-2");
    if (revised.content.status !== "available") {
      throw new TypeError("Expected an available revised page");
    }
    revised.content.items = [
      {
        ...paragraph(48),
        plainText: "Revised paragraph 48",
        inlines: [{ type: "text", text: "Revised paragraph 48" }],
      },
    ];
    restarted.resolve(response(revised));
    await settle();
    const revisedContinuation = host.nextCall();
    expect(revisedContinuation.request.arguments["cursor"]).toBe(
      "revised-page-2",
    );
    revisedContinuation.resolve(response(page(49)));
    await retry;
    expect(host.controller.getSnapshot().requestStatus).toBe("idle");
    expect(host.controller.getSnapshot().document?.complete).toBe(true);
    expect(
      host.controller.getSnapshot().document?.blocks.map((block) => block.id),
    ).toEqual(["block-48", "block-49"]);
    expect(
      host.controller.getSnapshot().document?.blocks.at(0)?.plainText,
    ).toBe("Revised paragraph 48");
    expect(host.controller.getSnapshot().documentRevision).toBe(1);
    expect(host.controller.range()).toEqual({ from: 48, to: 49 });
    expect(host.failures).toEqual([]);
  });

  test.each([
    {
      isError: false,
      content: [
        { type: "text", text: JSON.stringify({ error: { code: "conflict" } }) },
      ],
    },
    {
      isError: true,
      content: [{ type: "text", text: "There was a conflict." }],
    },
    {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: { code: "upstream_unavailable", message: "Retry later." },
          }),
        },
      ],
    },
  ] satisfies NonNullable<ToolResponse>[])(
    "other failed continuations retain their loaded pages and retry cursor (%#)",
    async (failure) => {
      const host = fixture();
      host.emit({ status: "ready", view: open() });
      host.nextCall().resolve(response(page(48, "page-2")));
      await settle();
      const continuation = host.controller.loadNext();
      host.nextCall().resolve(failure);
      await continuation;
      expect(host.controller.getSnapshot().requestStatus).toBe("error");
      const retry = host.controller.retry();
      const retried = host.nextCall();
      expect(retried.request.arguments["cursor"]).toBe("page-2");
      retried.resolve(response(page(49)));
      await retry;
      expect(host.controller.getSnapshot().document?.blocks).toEqual([
        paragraph(48),
        paragraph(49),
      ]);
      expect(host.controller.getSnapshot().documentRevision).toBe(0);
    },
  );
  test("concurrent page requests coalesce within one reader", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    await host.controller.loadNext();
    expect(host.calls).toHaveLength(1);
    host.nextCall().resolve(response(page(48)));
    await settle();
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
    ]);
  });
  test("separate reader sessions preserve their own documents and pagination", async () => {
    const first = fixture();
    first.emit({ status: "ready", view: open() });
    first.nextCall().resolve(response(page(48, "page-2")));
    await settle();
    const second = fixture();
    second.emit({ status: "ready", view: open() });
    second.nextCall().resolve(response(page(49)));
    await settle();
    expect(first.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
    ]);
    const continuation = first.controller.loadNext();
    const call = first.nextCall();
    expect(call.request.arguments["cursor"]).toBe("page-2");
    call.resolve(response(page(50)));
    await continuation;
    expect(first.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
      paragraph(50),
    ]);
    expect(second.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(49),
    ]);
  });
  test("repeated opens clear prior text and previews and reject their pending responses", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(48, "page-2")));
    await settle();
    const preview = {
      appUrl: null,
      documentId: metadata.decisionId,
      language: "cs",
      anchorId: "par-1",
      citedAnchorId: null,
      headings: [],
      heading: null,
      blocks: [],
    } satisfies ProvisionPreview;
    const initialPreview = host.controller.loadPreview({
      document_id: metadata.decisionId,
      anchor: "par-1",
    });
    host.nextCall().resolve(response(preview));
    await initialPreview;
    expect(host.controller.getSnapshot().preview?.anchorId).toBe("par-1");
    const stalePaging = host.controller.loadNext();
    const stalePage = host.nextCall();
    const stalePreviewing = host.controller.loadPreview({
      document_id: metadata.decisionId,
      anchor: "par-2",
    });
    const stalePreview = host.nextCall();
    host.emit({ status: "loading" });
    expect(host.controller.getSnapshot().document).toBeNull();
    expect(host.controller.getSnapshot().preview).toBeNull();
    host.emit({ status: "ready", view: open() });
    const fresh = host.nextCall();
    stalePage.resolve(response(page(49)));
    stalePreview.resolve(response({ ...preview, anchorId: "par-2" }));
    await Promise.all([stalePaging, stalePreviewing]);
    expect(host.controller.getSnapshot().document?.blocks).toEqual([]);
    expect(host.controller.getSnapshot().preview).toBeNull();
    expect(host.controller.getSnapshot().requestStatus).toBe("loading");
    fresh.resolve(response(page(50)));
    await settle();
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(50),
    ]);
    expect(host.controller.getSnapshot().preview).toBeNull();
  });
  test("failed provision previews retry the same reference after paging is complete", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(48)));
    await settle();
    const provision = {
      document_id: metadata.decisionId,
      anchor: "par-1",
      cited_anchor: "par-1-1",
    };
    const failedPreview = host.controller.loadPreview(provision);
    host.nextCall().resolve(undefined);
    await failedPreview;
    expect(host.controller.getSnapshot().previewStatus).toBe("error");
    const retry = host.controller.retry();
    expect(host.calls).toHaveLength(1);
    const call = host.nextCall();
    expect(call.request).toEqual({
      name: "preview_cited_provision",
      arguments: { provision },
    });
    call.resolve(
      response({
        appUrl: null,
        documentId: metadata.decisionId,
        language: "cs",
        anchorId: "par-1",
        citedAnchorId: "par-1-1",
        headings: [],
        heading: null,
        blocks: [],
      }),
    );
    await retry;
    expect(host.controller.getSnapshot().previewStatus).toBe("idle");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
    ]);
  });
  test("late failed pages preserve the newly opened reader and its request", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    const stale = host.nextCall();
    host.emit({ status: "loading" });
    host.emit({ status: "ready", view: open() });
    const fresh = host.nextCall();
    stale.resolve(undefined);
    await settle();
    expect(host.controller.getSnapshot().requestStatus).toBe("loading");
    expect(host.controller.bridge.getSnapshot().result.status).toBe("ready");
    fresh.resolve(response(page(49)));
    await settle();
    expect(host.controller.getSnapshot().requestStatus).toBe("idle");
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(49),
    ]);
  });
  test("opening failures retry through the bridge", async () => {
    const host = fixture();
    host.emit({ status: "error", message: "Opening failed" });
    await host.controller.retry();
    expect(host.openingRetries()).toBe(1);
  });
  test("host-operation failures retry through the bridge while preserving loaded text", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(48)));
    await settle();
    host.emit({ status: "error", message: "Host operation failed" });
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
    ]);
    await host.controller.retry();
    expect(host.openingRetries()).toBe(1);
    expect(host.calls).toHaveLength(0);
  });
  test("preview completion preserves an in-flight page request", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(48, "page-2")));
    await settle();
    const paging = host.controller.loadNext();
    const pageCall = host.nextCall();
    const previewing = host.controller.loadPreview({
      document_id: metadata.decisionId,
      anchor: "par-1",
    });
    const previewCall = host.nextCall();
    expect(host.controller.getSnapshot().previewStatus).toBe("loading");
    previewCall.resolve(
      response({
        appUrl: null,
        documentId: metadata.decisionId,
        language: "cs",
        anchorId: "par-1",
        citedAnchorId: null,
        headings: [],
        heading: null,
        blocks: [],
      }),
    );
    await previewing;
    expect(host.controller.getSnapshot().previewStatus).toBe("idle");
    expect(host.controller.getSnapshot().requestStatus).toBe("loading");
    await host.controller.loadNext();
    expect(host.calls).toHaveLength(0);
    pageCall.resolve(response(page(49)));
    await paging;
    expect(host.controller.getSnapshot().document?.blocks).toEqual([
      paragraph(48),
      paragraph(49),
    ]);
  });
  test("the latest provision preview wins when responses arrive out of order", async () => {
    const host = fixture();
    host.emit({ status: "ready", view: open() });
    host.nextCall().resolve(response(page(48)));
    await settle();
    const first = host.controller.loadPreview({
      document_id: metadata.decisionId,
      anchor: "par-1",
    });
    const firstCall = host.nextCall();
    const second = host.controller.loadPreview({
      document_id: metadata.decisionId,
      anchor: "par-2",
    });
    const secondCall = host.nextCall();
    const preview = {
      appUrl: "https://stella.example/legislation/1#par-2",
      documentId: metadata.decisionId,
      language: "cs",
      anchorId: "par-2",
      citedAnchorId: null,
      headings: [],
      heading: null,
      blocks: [],
    } satisfies ProvisionPreview;
    secondCall.resolve(response(preview));
    await second;
    firstCall.resolve(response({ ...preview, anchorId: "par-1" }));
    await first;
    expect(host.controller.getSnapshot().preview?.anchorId).toBe("par-2");
  });
});
