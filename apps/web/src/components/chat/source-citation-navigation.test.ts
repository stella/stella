import { describe, expect, mock, test } from "bun:test";

import { activateSourceCitation } from "@/components/chat/source-citation-navigation";
import { toSafeId } from "@/lib/safe-id";

const identity = {
  workspaceId: toSafeId<"workspace">("workspace-1"),
  entityId: toSafeId<"entity">("entity-1"),
  fieldId: toSafeId<"field">("field-cited"),
};

const createDeps = (opened = true) => ({
  dispatchBlockScroll: mock(() => undefined),
  openSource: mock(async () => opened),
  requestBlockScroll: mock(() => undefined),
  requestPdfPageScroll: mock(() => undefined),
});

describe("source-bound chat citation navigation", () => {
  test("queues a PDF page for the cited field after opening its source", async () => {
    const deps = createDeps();
    const target = {
      ...identity,
      type: "pdf-bates" as const,
      pageNumber: 9,
      bates: "F0-0009",
    };

    await activateSourceCitation({ deps, target });

    expect(deps.openSource).toHaveBeenCalledWith(target);
    expect(deps.requestPdfPageScroll).toHaveBeenCalledWith({
      tabId: identity.fieldId,
      pageNumber: 9,
    });
    expect(deps.requestBlockScroll).not.toHaveBeenCalled();
  });

  test("targets a verified DOCX block and passage to the cited field", async () => {
    const deps = createDeps();
    const target = {
      ...identity,
      type: "docx-folio" as const,
      blockId: "seq-0042",
      text: "The facility terminates on 31 December 2030.",
    };

    await activateSourceCitation({
      deps,
      target,
    });

    const request = {
      tabId: identity.fieldId,
      blockId: "seq-0042",
      text: "The facility terminates on 31 December 2030.",
    };
    expect(deps.requestBlockScroll).toHaveBeenCalledWith(request);
    expect(deps.dispatchBlockScroll).toHaveBeenCalledWith({
      fieldId: identity.fieldId,
      blockId: request.blockId,
      text: request.text,
    });
    expect(deps.requestPdfPageScroll).not.toHaveBeenCalled();
  });

  test("does not navigate when the exact source can no longer be opened", async () => {
    const deps = createDeps(false);

    await activateSourceCitation({
      deps,
      target: {
        ...identity,
        type: "pdf-bates",
        pageNumber: 2,
        bates: "F1-0002",
      },
    });

    expect(deps.requestPdfPageScroll).not.toHaveBeenCalled();
    expect(deps.requestBlockScroll).not.toHaveBeenCalled();
    expect(deps.dispatchBlockScroll).not.toHaveBeenCalled();
  });
});
