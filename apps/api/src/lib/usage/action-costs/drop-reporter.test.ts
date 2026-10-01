import { expect, mock, test } from "bun:test";

import { createDropReporter } from "./drop-reporter";

test("drop bursts use one scheduled report, retain the count and flush remaining drops", () => {
  const report = mock((_dropped: number, _cause?: unknown) => {});
  const cancel = mock(() => {});
  const schedule = mock((_callback: () => void) => cancel);
  const drops = createDropReporter({ report, schedule });
  const cause = new TypeError("fixture batch failure");
  for (let observation = 0; observation < 217; observation += 1) {
    drops.add(1);
  }
  drops.add(13, cause);
  drops.add(7, new TypeError("later fixture failure"));
  expect(schedule).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
  schedule.mock.calls.at(0)?.at(0)?.();
  expect(report).toHaveBeenNthCalledWith(1, 237, cause);
  drops.add(3);
  drops.flush();
  expect(report).toHaveBeenNthCalledWith(2, 3, undefined);
  expect(cancel).toHaveBeenCalledTimes(2);
  drops.flush();
  expect(report).toHaveBeenCalledTimes(2);
  schedule.mock.calls.at(1)?.at(0)?.();
  expect(report).toHaveBeenCalledTimes(2);
});
