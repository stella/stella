import { expect, test } from "bun:test";
import path from "node:path";

import {
  summarizeTypecheckFileTimes,
  typecheckProfilePath,
} from "./typecheck-profile";

test("profiling is opt-in and only selects the API compiler output", () => {
  expect(typecheckProfilePath("apps/api", undefined)).toBeUndefined();
  expect(typecheckProfilePath("apps/api", "")).toBeUndefined();
  for (const project of ["apps/web", "apps/web/e2e/tsconfig.json"]) {
    expect(typecheckProfilePath(project, "/runner/profile")).toBeUndefined();
  }
  expect(typecheckProfilePath("apps/api", "/runner/profile")).toBe(
    path.resolve("/runner/profile/api-file-times.tsv"),
  );
  expect(typecheckProfilePath("apps/api", "profile")).toBe(
    path.resolve("profile/api-file-times.tsv"),
  );
});

test("CPU summary aggregates repeated files and does not rank by wall time", () => {
  const timings = [
    "0\t9.000000\t0.200000\t10\t100\t2\t/repo/a.ts\tIdentifier=10 ",
    "0\t0.300000\t0.300000\t10\t100\t2\t/repo/b.ts\tIdentifier=10 ",
    "0\t0.200000\t0.200000\t10\t100\t2\t/repo/b.ts\tIdentifier=10 ",
    "0\t0.200000\t0.200000\t10\t100\t2\t/repo/c.ts\tIdentifier=10 ",
    "",
  ].join("\r\n");
  expect(summarizeTypecheckFileTimes(timings)).toEqual({
    ok: true,
    rows: [
      { file: "/repo/b.ts", seconds: 0.5 },
      { file: "/repo/a.ts", seconds: 0.2 },
      { file: "/repo/c.ts", seconds: 0.2 },
    ],
  });
  expect(summarizeTypecheckFileTimes("")).toEqual({ ok: true, rows: [] });
});

test("malformed timings fail instead of presenting a misleading profile", () => {
  for (const timing of [
    ...["", "NaN", "Infinity", "-1"].map(
      (cpu) => `0\t1\t${cpu}\t0\t0\t0\t/a.ts\t`,
    ),
    "0\t1\t2",
    "0\t1\t2\t0\t0\t0\t\t",
  ]) {
    expect(summarizeTypecheckFileTimes(timing)).toEqual({
      ok: false,
      error: "Invalid tsrs file timing at line 1",
    });
  }
});
