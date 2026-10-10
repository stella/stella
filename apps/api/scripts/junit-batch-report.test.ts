import { describe, expect, test } from "bun:test";

import {
  mergeJunitReports,
  planBatchReporterArguments,
} from "./junit-batch-report";

describe("batch reporter arguments", () => {
  test("rewrites equals-form outfiles for every batch", () => {
    expect(
      planBatchReporterArguments(
        ["--reporter=junit", "--reporter-outfile=final.xml"],
        2,
        "/tmp/reports",
      ),
    ).toEqual({
      type: "file",
      requestedOutfile: "final.xml",
      batchOutfiles: ["/tmp/reports/batch-0.xml", "/tmp/reports/batch-1.xml"],
      argumentsByBatch: [
        ["--reporter=junit", "--reporter-outfile=/tmp/reports/batch-0.xml"],
        ["--reporter=junit", "--reporter-outfile=/tmp/reports/batch-1.xml"],
      ],
    });
  });

  test("rewrites separate-value outfiles for every batch", () => {
    const plan = planBatchReporterArguments(
      ["--reporter-outfile", "final.xml", "--rerun-each=2"],
      1,
      "/tmp/reports",
    );
    expect(plan.type).toBe("file");
    expect(plan.argumentsByBatch).toEqual([
      ["--reporter-outfile", "/tmp/reports/batch-0.xml", "--rerun-each=2"],
    ]);
  });

  test("leaves arguments unchanged without an outfile", () => {
    expect(
      planBatchReporterArguments(["--reporter=junit"], 2, "/unused"),
    ).toEqual({
      type: "stdout",
      argumentsByBatch: [["--reporter=junit"], ["--reporter=junit"]],
    });
  });
});

describe("JUnit batch merging", () => {
  test("preserves suite order and sums every root total that is present", () => {
    const merged = mergeJunitReports([
      {
        source: "first.xml",
        xml: '<testsuites tests="2" failures="1" errors="0" skipped="1" time="1.25"><testsuite name="ordinary"><testcase name="a" /></testsuite></testsuites>',
      },
      {
        source: "second.xml",
        xml: '<testsuites tests="3" failures="0" errors="1" skipped="0" time="2.5"><testsuite name="isolated-one" /><testsuite name="isolated-two" /></testsuites>',
      },
    ]);

    expect(merged).toContain(
      '<testsuites tests="5" failures="1" errors="1" skipped="1" time="3.75">',
    );
    expect(merged.indexOf('name="ordinary"')).toBeLessThan(
      merged.indexOf('name="isolated-one"'),
    );
    expect(merged.indexOf('name="isolated-one"')).toBeLessThan(
      merged.indexOf('name="isolated-two"'),
    );
  });

  test("panics on an unparseable batch instead of dropping it", () => {
    expect(() =>
      mergeJunitReports([
        { source: "broken.xml", xml: "<testsuites><testsuite>" },
      ]),
    ).toThrow("Unparseable JUnit report broken.xml");
  });

  test("copies failure output with markup verbatim", () => {
    const failure =
      '<testsuite name="ordinary"><testcase name="a"><failure><![CDATA[expected <div> but got </span>]]></failure></testcase></testsuite>';
    const merged = mergeJunitReports([
      {
        source: "first.xml",
        xml: `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="1">${failure}</testsuites>\n`,
      },
      { source: "empty.xml", xml: '<testsuites tests="0" />' },
    ]);
    expect(merged).toContain(failure);
    expect(merged).toContain('<testsuites tests="1" failures="1">');
  });

  test("panics on a report without a root", () => {
    expect(() =>
      mergeJunitReports([{ source: "missing.xml", xml: "" }]),
    ).toThrow("Unparseable JUnit report missing.xml");
  });
});
