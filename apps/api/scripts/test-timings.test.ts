import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadTestDurationWeights, readTimingArtifact } from "./test-timings";

test("unknown live tests use the median cached weight with a notice", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-test-durations-"));
  const filename = path.join(directory, "weights.json");
  writeFileSync(
    filename,
    JSON.stringify({
      a: { seconds: 2, source: "measured" },
      b: { seconds: 8, source: "measured" },
      deleted: { seconds: 10_000, source: "measured" },
    }),
  );
  const notices: string[] = [];
  try {
    expect(
      loadTestDurationWeights({
        files: ["a", "b", "new"],
        path: filename,
        notice: (message) => {
          notices.push(message);
        },
      }),
    ).toEqual({ a: 2, b: 8, new: 8 });
    expect(notices).toEqual([
      "::notice::1 API test file(s) use the median duration weight",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unusable duration caches fall back uniformly without throwing", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "api-test-durations-"));
  const filename = path.join(directory, "weights.json");
  const notice = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    for (const contents of [
      "not json",
      JSON.stringify([]),
      JSON.stringify({ a: { seconds: "wrong", source: "measured" } }),
      JSON.stringify({}),
      JSON.stringify({ deleted: { seconds: 9, source: "measured" } }),
    ]) {
      writeFileSync(filename, contents);
      notice.mockClear();
      expect(
        loadTestDurationWeights({ files: ["live"], path: filename }),
      ).toEqual({ live: 1 });
      expect(notice.mock.calls.at(0)?.at(0)).toContain("::notice::");
    }
    notice.mockClear();
    expect(
      loadTestDurationWeights({
        files: ["live"],
        path: path.join(directory, "missing.json"),
      }),
    ).toEqual({ live: 1 });
    expect(notice.mock.calls.at(0)?.at(0)).toContain("::notice::");
  } finally {
    notice.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native milliseconds normalize to seconds and malformed artifacts fail", () => {
  expect(
    readTimingArtifact('{"version":1,"files":{"./src/one.test.ts":2300}}'),
  ).toEqual({ "src/one.test.ts": 2.3 });
  expect(() => readTimingArtifact('{"version":2,"files":{}}')).toThrow(
    "Invalid",
  );
});
