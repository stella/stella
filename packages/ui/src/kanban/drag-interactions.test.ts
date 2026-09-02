import { describe, expect, mock, test } from "bun:test";

// The real `draggable` reaches into DOM APIs (addEventListener, dataset, ...)
// that this bun:test process has no DOM for. It is replaced with a stand-in
// that only records the arguments it was called with, before importing the
// module under test. Every other export is passed through untouched so
// unrelated kanban tests sharing this bun:test process are unaffected.
const realAdapter =
  await import("@atlaskit/pragmatic-drag-and-drop/element/adapter");

type DraggableArgs = Parameters<typeof realAdapter.draggable>[0];

let capturedArgs: DraggableArgs | undefined;

void mock.module("@atlaskit/pragmatic-drag-and-drop/element/adapter", () => ({
  ...realAdapter,
  draggable: (args: DraggableArgs) => {
    capturedArgs = args;
    return () => undefined;
  },
}));

const { KANBAN_CARD_DRAG_MIME, registerKanbanCardDrag } =
  await import("./drag-interactions");

// SAFETY: the mocked `draggable` above only stores `element` without ever
// touching a real DOM API on it, so a plain object stands in for it here.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for a DOM element; see the SAFETY note above.
const stubElement = (): HTMLElement => ({}) as unknown as HTMLElement;

// SAFETY: `getInitialDataForExternal` ignores the feedback args entirely
// (see drag-interactions.ts), so this stub only needs to satisfy the call
// signature, never to be read.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double for feedback args; see the SAFETY note above.
const stubFeedbackArgs = {} as Parameters<
  NonNullable<DraggableArgs["getInitialDataForExternal"]>
>[0];

describe("registerKanbanCardDrag", () => {
  test("marks the drag with the kanban card MIME type for the board's native listeners", () => {
    registerKanbanCardDrag({
      element: stubElement(),
      getInitialData: () => ({}),
    });

    expect(capturedArgs?.getInitialDataForExternal?.(stubFeedbackArgs)).toEqual(
      { [KANBAN_CARD_DRAG_MIME]: "" },
    );
  });
});
