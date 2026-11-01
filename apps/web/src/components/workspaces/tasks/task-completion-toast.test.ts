import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { TASK_STATUSES } from "@stll/api-contract";
import type { TaskStatus } from "@stll/api-contract";
import { stellaToast } from "@stll/ui/toast";

import { notifyTaskCompletion } from "./task-completion-toast";

afterEach(() => {
  mock.restore();
});

describe("completing a task", () => {
  test("offers a way back to every status it came from", () => {
    const add = spyOn(stellaToast, "add").mockReturnValue("toast");
    for (const previous of TASK_STATUSES.filter(
      (status) => status !== "done",
    )) {
      add.mockClear();
      const restored: TaskStatus[] = [];
      notifyTaskCompletion({
        next: "done",
        previous,
        restore: (status) => restored.push(status),
      });

      const toast = add.mock.calls.at(0)?.at(0);
      expect(add).toHaveBeenCalledTimes(1);
      expect(toast).toMatchObject({ action: { label: "Undo" } });
      const undo = toast?.action?.onClick;
      if (undo === undefined) {
        throw new TypeError("The completion toast must offer an undo");
      }
      Reflect.apply(undo, undefined, []);
      expect(restored).toEqual([previous]);
    }
  });

  test("stays quiet for any other status change", () => {
    const add = spyOn(stellaToast, "add").mockReturnValue("toast");
    for (const next of TASK_STATUSES.filter((status) => status !== "done")) {
      notifyTaskCompletion({ next, previous: "open", restore: () => {} });
    }
    notifyTaskCompletion({ next: "done", previous: "done", restore: () => {} });

    expect(add).not.toHaveBeenCalled();
  });
});
