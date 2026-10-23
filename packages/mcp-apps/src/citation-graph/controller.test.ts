import { describe, expect, test } from "bun:test";

import type { OpenDecision } from "../shared/generated/contracts";
import { createGraphController } from "./controller";
import type { CitationPage } from "./parse";

type GraphBridge = NonNullable<Parameters<typeof createGraphController>[0]>;
type BridgeSnapshot = ReturnType<GraphBridge["getSnapshot"]>;
type BridgeToolResult = NonNullable<
  Awaited<ReturnType<GraphBridge["requestTool"]>>
>;
type ToolRequest = Parameters<GraphBridge["requestTool"]>[0];

const page = ({
  decisionId = "synthetic-subject",
  direction = "cites",
  nextCursor = null,
  citations = [],
}: {
  decisionId?: string;
  direction?: CitationPage["direction"];
  nextCursor?: string | null;
  citations?: CitationPage["citations"];
} = {}) =>
  ({
    doctrineAvailability: "unavailable",
    decisionId,
    direction,
    nextCursor,
    citations,
  }) satisfies CitationPage;

const citation = (citationId: string, decisionId = "synthetic-target") =>
  ({
    citationId,
    citationText: `Synthetic citation ${citationId}`,
    textWithheldReason: null,
    polarity: "unclassified",
    doctrine: null,
    decision: {
      url: `https://stll.app/case-law/${decisionId}`,
      caseNumber: `Synthetic ${decisionId}`,
      citationAuthority: 1,
      court: "Synthetic Court",
      decisionDate: null,
      decisionId,
      decisionType: null,
      resourceName: `case-law/${decisionId}`,
    },
    passage: null,
  }) satisfies CitationPage["citations"][number];

const toolResult = (
  structuredContent: Record<string, unknown>,
  {
    isError = false,
    text = "synthetic tool response",
  }: { isError?: boolean; text?: string } = {},
) =>
  ({
    content: [{ type: "text", text }],
    isError,
    structuredContent,
  }) satisfies BridgeToolResult;

const openedDecision = (decisionId: string, url: string | null) =>
  ({
    status: "unavailable",
    metadata: {
      decisionId,
      url,
      caseNumber: "Synthetic case",
      caseNumberType: "case-number",
      courtAbbreviation: null,
      courtTier: "supreme",
      language: "en",
      court: "Synthetic court",
      country: "cze",
      date: null,
      ecli: null,
    },
  }) satisfies OpenDecision;

const createBridge = ({
  supportsTools = true,
  linkError = "synthetic link failure",
}: { supportsTools?: boolean; linkError?: string | null } = {}) => {
  let current: BridgeSnapshot = {
    context: {},
    input: {},
    tool: "read_case_law_citations",
    result: { status: "idle" },
  };
  let listener: (() => void) | undefined;
  const requests: ToolRequest[] = [];
  const pending: ((result: BridgeToolResult | undefined) => void)[] = [];
  const openedLinks: string[] = [];
  const bridge = {
    subscribe: (next: () => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    getSnapshot: () => current,
    supportsTools: () => supportsTools,
    requestTool: async (request: ToolRequest) => {
      requests.push(request);
      return new Promise<BridgeToolResult | undefined>((resolve) => {
        pending.push(resolve);
      });
    },
    openLink: async (
      url: string,
      onError?: (message: string | null) => void,
    ) => {
      openedLinks.push(url);
      if (linkError !== null) {
        onError?.(linkError);
      }
    },
  } satisfies GraphBridge;

  return {
    bridge,
    requests,
    openedLinks,
    emit: (result: BridgeSnapshot["result"]) => {
      current = { ...current, result };
      listener?.();
    },
    resolveNext: (result: BridgeToolResult | undefined) => {
      const resolve = pending.shift();
      if (resolve === undefined) {
        throw new Error("No pending synthetic tool request");
      }
      resolve(result);
    },
  };
};

const startWithPage = (
  bridge: ReturnType<typeof createBridge>,
  initial: CitationPage,
) => {
  const controller = createGraphController(bridge.bridge);
  bridge.emit({ status: "ready", view: initial });
  return controller;
};

describe("citation graph controller", () => {
  test("resends applied filters when loading another page", async () => {
    const bridge = createBridge();
    const controller = startWithPage(bridge, {
      ...page({ nextCursor: "synthetic-cursor" }),
      doctrine: "limits",
      polarity: "negative",
    });

    const reading = controller.read("synthetic-subject");
    expect(bridge.requests.at(0)?.arguments).toEqual({
      decision_id: "synthetic-subject",
      direction: "cites",
      doctrine: "limits",
      polarity: "negative",
      cursor: "synthetic-cursor",
    });
    bridge.resolveNext(toolResult(page()));
    await reading;
  });

  test.each(["synthetic-subject", "synthetic-target"])(
    "rejects a non-advancing cursor without merging or losing retry state for %s",
    async (decisionId) => {
      const bridge = createBridge();
      const controller = startWithPage(
        bridge,
        page({ nextCursor: "synthetic-cursor" }),
      );
      if (decisionId !== "synthetic-subject") {
        const expansion = controller.read(decisionId);
        bridge.resolveNext(
          toolResult(page({ decisionId, nextCursor: "synthetic-cursor" })),
        );
        await expansion;
      }
      const originalModel = controller.getSnapshot().model;
      const reading = controller.read(decisionId);
      bridge.resolveNext(
        toolResult(
          page({
            decisionId,
            nextCursor: "synthetic-cursor",
            citations: [citation("synthetic-repeated-page-edge")],
          }),
        ),
      );
      await reading;
      expect(controller.getSnapshot().model).toBe(originalModel);
      expect(controller.getSnapshot().request.status).toBe("error");

      const retry = controller.read(decisionId);
      expect(bridge.requests.at(-1)?.arguments).toEqual({
        decision_id: decisionId,
        direction: "cites",
        cursor: "synthetic-cursor",
      });
      bridge.resolveNext(toolResult(page({ decisionId })));
      await retry;
      expect(controller.getSnapshot().request.status).toBe("idle");
      expect(
        controller
          .getSnapshot()
          .model?.pages.find((entry) => entry.decisionId === decisionId)
          ?.nextCursor,
      ).toBeNull();
    },
  );

  test("serializes opening and paging so a late opening cannot release a pending read", async () => {
    const bridge = createBridge({ linkError: null });
    const controller = startWithPage(
      bridge,
      page({ nextCursor: "synthetic-cursor" }),
    );
    const opening = controller.open("synthetic-target", null);
    await controller.read("synthetic-subject");
    await controller.open("synthetic-target", null);
    expect(bridge.requests).toHaveLength(1);
    bridge.resolveNext(
      toolResult(
        openedDecision("synthetic-target", "https://example.org/selected"),
      ),
    );
    await opening;
    const reading = controller.read("synthetic-subject");
    await controller.open("synthetic-target", null);
    expect(bridge.requests).toHaveLength(2);
    expect(controller.getSnapshot().request.status).toBe("loading");
    bridge.resolveNext(toolResult(page()));
    await reading;
    expect(controller.getSnapshot().request.status).toBe("idle");
  });
  test("ignores a duplicate read while a request is loading", async () => {
    const bridge = createBridge();
    const controller = startWithPage(
      bridge,
      page({ nextCursor: "synthetic-cursor" }),
    );
    const firstRead = controller.read("synthetic-subject");

    await controller.read("synthetic-subject");
    expect(bridge.requests).toHaveLength(1);
    expect(controller.getSnapshot().request.status).toBe("loading");

    bridge.resolveNext(toolResult(page({ decisionId: "synthetic-subject" })));
    await firstRead;
    expect(controller.getSnapshot().request.status).toBe("idle");
  });

  test("discards a late expansion response after the host resets the app", async () => {
    const bridge = createBridge();
    const controller = startWithPage(
      bridge,
      page({ citations: [citation("synthetic-edge")] }),
    );
    const expansion = controller.read("synthetic-target");

    bridge.emit({ status: "loading" });
    expect(controller.getSnapshot()).toMatchObject({
      model: null,
      request: { status: "idle" },
    });
    bridge.resolveNext(toolResult(page({ decisionId: "synthetic-target" })));
    await expansion;

    expect(controller.getSnapshot()).toMatchObject({
      model: null,
      request: { status: "idle" },
    });
  });

  test("reports a mismatched subject response while preserving the graph", async () => {
    const bridge = createBridge();
    const controller = startWithPage(
      bridge,
      page({ citations: [citation("synthetic-edge")] }),
    );
    const originalModel = controller.getSnapshot().model;
    const expansion = controller.read("synthetic-target");

    bridge.resolveNext(
      toolResult(page({ decisionId: "synthetic-wrong-subject" }), {
        text: "synthetic subject mismatch",
      }),
    );
    await expansion;

    expect(controller.getSnapshot()).toMatchObject({
      model: originalModel,
      request: { status: "error", message: "synthetic subject mismatch" },
    });
  });

  test("uses the expanded decision cursor for its next page", async () => {
    const bridge = createBridge();
    const controller = startWithPage(
      bridge,
      page({ citations: [citation("synthetic-edge")] }),
    );
    const firstRead = controller.read("synthetic-target");
    bridge.resolveNext(
      toolResult(
        page({
          decisionId: "synthetic-target",
          nextCursor: "synthetic-next-cursor",
          citations: [
            citation("synthetic-expanded-edge-a", "synthetic-other-a"),
          ],
        }),
      ),
    );
    await firstRead;

    const nextRead = controller.read("synthetic-target");
    expect(bridge.requests.at(1)?.arguments).toEqual({
      decision_id: "synthetic-target",
      direction: "cites",
      cursor: "synthetic-next-cursor",
    });
    bridge.resolveNext(
      toolResult(
        page({
          decisionId: "synthetic-target",
          citations: [
            citation("synthetic-expanded-edge-b", "synthetic-other-b"),
          ],
        }),
      ),
    );
    await nextRead;

    expect(
      controller
        .getSnapshot()
        .model?.pages.find(
          ({ decisionId }) => decisionId === "synthetic-target",
        )
        ?.citations.map(({ citationId }) => citationId),
    ).toEqual(["synthetic-expanded-edge-a", "synthetic-expanded-edge-b"]);
  });

  test("does not dispatch a sixth expanded decision", async () => {
    const bridge = createBridge();
    const controller = startWithPage(bridge, page());

    for (let index = 0; index < 5; index += 1) {
      const decisionId = `synthetic-expanded-${index}`;
      const expansion = controller.read(decisionId);
      bridge.resolveNext(toolResult(page({ decisionId })));
      await expansion;
    }
    const requestCount = bridge.requests.length;

    await controller.read("synthetic-expanded-sixth");

    expect(bridge.requests).toHaveLength(requestCount);
    expect(controller.getSnapshot().model?.expanded).toHaveLength(5);
  });

  test("surfaces open-tool failures without discarding the graph", async () => {
    const bridge = createBridge();
    const controller = startWithPage(bridge, page());
    const originalModel = controller.getSnapshot().model;
    const opening = controller.open("synthetic-subject", null);

    bridge.resolveNext(
      toolResult({}, { isError: true, text: "synthetic open failure" }),
    );
    await opening;

    expect(controller.getSnapshot()).toMatchObject({
      model: originalModel,
      request: { status: "error", message: "synthetic open failure" },
    });
    expect(bridge.requests.at(0)).toEqual({
      name: "open_case_law_decision",
      arguments: { decision_id: "synthetic-subject" },
    });
  });

  test("opens the validated URL returned by the selected decision tool", async () => {
    const bridge = createBridge({ linkError: null });
    const controller = startWithPage(bridge, page());
    const opening = controller.open(
      "synthetic-target",
      "https://example.org/old",
    );
    bridge.resolveNext(
      toolResult(
        openedDecision("synthetic-target", "https://example.org/selected"),
      ),
    );
    await opening;
    expect(bridge.openedLinks).toEqual(["https://example.org/selected"]);
    expect(controller.getSnapshot().request.status).toBe("idle");
  });

  test("does not navigate a late open result after the host resets the graph", async () => {
    const bridge = createBridge({ linkError: null });
    const controller = startWithPage(bridge, page());
    const opening = controller.open("synthetic-target", null);
    bridge.emit({ status: "loading" });
    bridge.resolveNext(
      toolResult(
        openedDecision("synthetic-target", "https://example.org/selected"),
      ),
    );
    await opening;
    expect(bridge.openedLinks).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      model: null,
      request: { status: "idle" },
    });
  });

  test("preserves a host navigation refusal after a successful open call", async () => {
    const bridge = createBridge();
    const controller = startWithPage(bridge, page());
    const opening = controller.open("synthetic-target", null);
    bridge.resolveNext(
      toolResult(
        openedDecision("synthetic-target", "https://example.org/selected"),
      ),
    );
    await opening;
    expect(bridge.openedLinks).toEqual(["https://example.org/selected"]);
    expect(controller.getSnapshot().request).toEqual({
      status: "error",
      message: "synthetic link failure",
    });
  });

  test.each([
    {},
    openedDecision("synthetic-other", "https://example.org/selected"),
    openedDecision("synthetic-target", null),
    openedDecision("synthetic-target", "file:///synthetic-decision"),
  ])(
    "rejects an invalid or mismatched open result without navigating (%#)",
    async (result) => {
      const bridge = createBridge({ linkError: null });
      const controller = startWithPage(bridge, page());
      const opening = controller.open("synthetic-target", null);
      bridge.resolveNext(toolResult(result));
      await opening;
      expect(bridge.openedLinks).toEqual([]);
      expect(controller.getSnapshot().request.status).toBe("error");
    },
  );

  test("surfaces fallback link failures while preserving the graph", async () => {
    const bridge = createBridge({ supportsTools: false });
    const controller = startWithPage(bridge, page());
    const originalModel = controller.getSnapshot().model;

    await controller.open(
      "synthetic-subject",
      "https://stll.app/case-law/synthetic-subject",
    );

    expect(bridge.openedLinks).toEqual([
      "https://stll.app/case-law/synthetic-subject",
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      model: originalModel,
      request: { status: "error", message: "synthetic link failure" },
    });
    expect(bridge.requests).toHaveLength(0);
  });
});
