import { describe, expect, it } from "bun:test";

import { destroyPDFDocument } from "@/lib/pdf/pdf-cleanup";

const makeTask = (sink: string[], id: string) => ({
  destroy: () => {
    sink.push(id);
    return Promise.resolve();
  },
});

describe("destroyPDFDocument", () => {
  it("destroys the main loading task and every attachment task", async () => {
    const destroyed: string[] = [];

    await destroyPDFDocument({
      loadingTask: makeTask(destroyed, "main"),
      attachmentLoadingTasks: [
        makeTask(destroyed, "att-1"),
        makeTask(destroyed, "att-2"),
      ],
    });

    expect(destroyed.toSorted()).toEqual(["att-1", "att-2", "main"]);
  });

  it("destroys the main task when there are no attachments", async () => {
    const destroyed: string[] = [];

    await destroyPDFDocument({
      loadingTask: makeTask(destroyed, "main"),
      attachmentLoadingTasks: [],
    });

    expect(destroyed).toEqual(["main"]);
  });

  it("awaits every task's destroy() before resolving", async () => {
    let settled = 0;
    const deferred = () => {
      let release = () => {};
      const destroy = () =>
        new Promise<void>((resolve) => {
          release = () => {
            settled++;
            resolve();
          };
        });
      return { destroy, release: () => release() };
    };

    const main = deferred();
    const att = deferred();
    const done = destroyPDFDocument({
      loadingTask: { destroy: main.destroy },
      attachmentLoadingTasks: [{ destroy: att.destroy }],
    });

    main.release();
    att.release();
    await done;

    expect(settled).toBe(2);
  });
});
