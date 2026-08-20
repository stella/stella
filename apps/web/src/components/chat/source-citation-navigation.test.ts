import { describe, expect, mock, test } from "bun:test";

import type { ChatSourceCitationTarget } from "@stll/api-contract";

import { activateSourceCitation } from "@/components/chat/source-citation-navigation";
import { toSafeId } from "@/lib/safe-id";

const identity = {
  workspaceId: toSafeId<"workspace">("workspace-1"),
  entityId: toSafeId<"entity">("entity-1"),
  entityVersionId: toSafeId<"entityVersion">("version-1"),
  fieldId: toSafeId<"field">("field-cited"),
};

const createDeps = (opened = true) => ({
  dispatchBlockScroll: mock(() => undefined),
  openSource: mock(
    async (_target: ChatSourceCitationTarget, _isCurrent: () => boolean) =>
      opened,
  ),
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

    expect(deps.openSource).toHaveBeenCalledWith(target, expect.any(Function));
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

  test("ignores a citation whose source resolves after a newer activation", async () => {
    let finishFirst: ((opened: boolean) => void) | undefined;
    const firstOpened = new Promise<boolean>((resolve) => {
      finishFirst = resolve;
    });
    const deps = createDeps();
    deps.openSource = mock(async (target: ChatSourceCitationTarget) =>
      target.fieldId === identity.fieldId ? await firstOpened : true,
    );
    const first = activateSourceCitation({
      deps,
      target: {
        ...identity,
        type: "pdf-bates",
        pageNumber: 2,
        bates: "F0-0002",
      },
    });
    const newerTarget = {
      ...identity,
      entityId: toSafeId<"entity">("entity-2"),
      entityVersionId: toSafeId<"entityVersion">("version-2"),
      fieldId: toSafeId<"field">("field-newer"),
      type: "pdf-bates" as const,
      pageNumber: 8,
      bates: "F1-0008",
    };

    await activateSourceCitation({ deps, target: newerTarget });
    finishFirst?.(true);
    await first;

    expect(deps.requestPdfPageScroll).toHaveBeenCalledTimes(1);
    expect(deps.requestPdfPageScroll).toHaveBeenCalledWith({
      tabId: newerTarget.fieldId,
      pageNumber: newerTarget.pageNumber,
    });
  });
});
