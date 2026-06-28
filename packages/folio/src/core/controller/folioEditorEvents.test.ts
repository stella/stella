import { describe, expect, test } from "bun:test";

import {
  createFolioEditorEmitter,
  type FolioSelectionEvent,
} from "./folioEditorEvents";

describe("createFolioEditorEmitter", () => {
  test("delivers an emitted payload to a subscriber", () => {
    const emitter = createFolioEditorEmitter();
    const seen: FolioSelectionEvent[] = [];
    emitter.on("selectionChange", (s) => {
      seen.push(s);
    });

    emitter.emit("selectionChange", { from: 1, to: 4 });

    expect(seen).toEqual([{ from: 1, to: 4 }]);
  });

  test("only notifies listeners of the emitted event", () => {
    const emitter = createFolioEditorEmitter();
    let selectionCalls = 0;
    let docCalls = 0;
    emitter.on("selectionChange", () => {
      selectionCalls += 1;
    });
    emitter.on("docChange", () => {
      docCalls += 1;
    });

    emitter.emit("selectionChange", { from: 0, to: 0 });

    expect(selectionCalls).toBe(1);
    expect(docCalls).toBe(0);
  });

  test("fans out to every subscriber of an event", () => {
    const emitter = createFolioEditorEmitter();
    let a = 0;
    let b = 0;
    emitter.on("selectionChange", () => {
      a += 1;
    });
    emitter.on("selectionChange", () => {
      b += 1;
    });

    emitter.emit("selectionChange", { from: 0, to: 0 });

    expect([a, b]).toEqual([1, 1]);
  });

  test("the returned unsubscribe stops further delivery", () => {
    const emitter = createFolioEditorEmitter();
    let calls = 0;
    const off = emitter.on("selectionChange", () => {
      calls += 1;
    });

    emitter.emit("selectionChange", { from: 0, to: 0 });
    off();
    emitter.emit("selectionChange", { from: 0, to: 0 });

    expect(calls).toBe(1);
  });

  test("a listener that unsubscribes mid-emit does not perturb the current fan-out", () => {
    const emitter = createFolioEditorEmitter();
    const order: string[] = [];
    const off = emitter.on("selectionChange", () => {
      order.push("first");
      off();
    });
    emitter.on("selectionChange", () => {
      order.push("second");
    });

    emitter.emit("selectionChange", { from: 0, to: 0 });

    // Both run on the snapshot taken before the unsubscribe.
    expect(order).toEqual(["first", "second"]);
  });

  test("clear drops all listeners", () => {
    const emitter = createFolioEditorEmitter();
    let calls = 0;
    emitter.on("selectionChange", () => {
      calls += 1;
    });

    emitter.clear();
    emitter.emit("selectionChange", { from: 0, to: 0 });

    expect(calls).toBe(0);
  });

  test("emitting with no listeners is a no-op", () => {
    const emitter = createFolioEditorEmitter();
    expect(() => {
      emitter.emit("selectionChange", { from: 0, to: 0 });
    }).not.toThrow();
  });
});
