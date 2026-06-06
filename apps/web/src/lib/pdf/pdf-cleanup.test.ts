import { describe, expect, it } from "bun:test";

import { destroyPDFDocument } from "@/lib/pdf/pdf-cleanup";

// Defers the side effect to a microtask so a non-awaiting destroyPDFDocument
// would resolve before any onDestroy ran.
const makeTask = (onDestroy: () => void) => ({
  destroy: async () => {
    await Promise.resolve();
    onDestroy();
  },
});

describe("destroyPDFDocument", () => {
  it("destroys the main loading task and every attachment task", async () => {
    const destroyed: string[] = [];

    await destroyPDFDocument({
      loadingTask: makeTask(() => {
        destroyed.push("main");
      }),
      attachmentLoadingTasks: [
        makeTask(() => {
          destroyed.push("att-1");
        }),
        makeTask(() => {
          destroyed.push("att-2");
        }),
      ],
    });

    expect(destroyed.toSorted()).toEqual(["att-1", "att-2", "main"]);
  });

  it("destroys the main task when there are no attachments", async () => {
    const destroyed: string[] = [];

    await destroyPDFDocument({
      loadingTask: makeTask(() => {
        destroyed.push("main");
      }),
      attachmentLoadingTasks: [],
    });

    expect(destroyed).toEqual(["main"]);
  });

  it("awaits every task's destroy() before resolving", async () => {
    let completed = 0;
    const bump = () => {
      completed++;
    };

    await destroyPDFDocument({
      loadingTask: makeTask(bump),
      attachmentLoadingTasks: [makeTask(bump), makeTask(bump)],
    });

    expect(completed).toBe(3);
  });
});
