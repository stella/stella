import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { recordCellStateSchema } from "@stll/api-contract/record-cell";
import {
  RECORD_LIMITS,
  recordSchemaSchema,
} from "@stll/api-contract/record-schema";
import type { RecordValue } from "@stll/api-contract/record-schema";
import { assertProperty, propertySeed } from "@stll/property-testing";
import { sha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";
import { Temporal } from "@stll/time";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type {
  DataSourceAnswer,
  DataSourceTool,
} from "@/api/lib/data-sources/contract";
import {
  DataSourceUnavailableError,
  textInput,
} from "@/api/lib/data-sources/contract";
import { DATA_SOURCE_TOOLS } from "@/api/lib/data-sources/registry";
import {
  isReusableRecord,
  runDataSourceTool,
} from "@/api/lib/data-sources/run";
import type { FilledToolInput } from "@/api/lib/data-sources/run";

const NOW = Temporal.Instant.from("2026-11-04T12:00:00Z");

type FakeToolOptions = {
  match?: DataSourceTool["match"];
  cardinality?: "one" | "many";
  answer: DataSourceAnswer | DataSourceUnavailableError;
};

/** A source with a checksum-style input rule; counts its calls. */
const fakeTool = ({
  match = "exact",
  cardinality = "one",
  answer,
}: FakeToolOptions) => {
  const calls: RecordValue[] = [];
  const tool: DataSourceTool = {
    id: "test.fake.lookup",
    description: "A fake lookup",
    input: {
      cardinality: "one",
      fields: [
        { key: "code", label: "Code", type: "text", nullable: false },
        { key: "on", label: "On", type: "date", nullable: true },
      ],
    },
    checkInput: (input) => {
      const code = textInput(input, "code").trim();
      return code.endsWith("7")
        ? Result.ok({ ...input, code })
        : Result.err([{ key: "code", code: "invalid", message: "Checksum" }]);
    },
    output: {
      schema: {
        cardinality,
        fields: [{ key: "name", label: "Name", type: "text", nullable: false }],
      },
      version: 3,
    },
    match,
    cacheTtl: { hours: 2 },
    call: async (input) => {
      calls.push(input);
      return answer instanceof DataSourceUnavailableError
        ? Result.err(answer)
        : Result.ok(answer);
    },
  };
  return { tool, calls };
};

const run = async (tool: DataSourceTool, filled: FilledToolInput) =>
  await runDataSourceTool({
    tool,
    filled,
    context: {
      permit: grantThirdPartyOutboundPermit(),
      observer: "unobserved",
      signal: new AbortController().signal,
    },
    now: NOW,
    timeZone: "Europe/Prague",
  });

const found = (names: readonly string[]): DataSourceAnswer => ({
  type: "records",
  records: names.map((name) => ({ name })),
  url: "https://example.test/source",
});

describe("input gating", () => {
  test("refused input is stored for review and the source is never called", async () => {
    await assertProperty(
      "refused input is stored for review and the source is never called",
      fc.asyncProperty(
        fc.oneof(
          // Missing required value.
          fc.constant<FilledToolInput>({
            values: { code: null },
            uncertainKeys: [],
          }),
          // Wrong type.
          fc.integer().map((code): FilledToolInput => ({
            values: { code, on: null },
            uncertainKeys: [],
          })),
          // Fails the tool's own check.
          fc
            .stringMatching(/^[0-9]{3,8}[0-68-9]$/u)
            .map((code): FilledToolInput => ({
              values: { code },
              uncertainKeys: [],
            })),
          // Valid but doubted by the model.
          fc.stringMatching(/^[0-9]{3,8}7$/u).map((code): FilledToolInput => ({
            values: { code },
            uncertainKeys: ["code"],
          })),
        ),
        async (filled) => {
          const { tool, calls } = fakeTool({ answer: found(["A"]) });
          const outcome = await run(tool, filled);
          expect(calls).toEqual([]);
          const cell = outcome.unwrap();
          expect(cell.state.status).toBe("input-needs-review");
          expect(v.is(recordCellStateSchema, cell.state)).toBe(true);
        },
      ),
      { seed: propertySeed() },
    );
  });

  test("a field refused and also doubted carries one issue", async () => {
    const { tool, calls } = fakeTool({ answer: found(["A"]) });
    const cell = (
      await run(tool, { values: { code: null }, uncertainKeys: ["code"] })
    ).unwrap();
    expect(calls).toEqual([]);
    expect(cell.state).toMatchObject({
      status: "input-needs-review",
      issues: [{ key: "code", code: "missing" }],
    });
    expect(v.is(recordCellStateSchema, cell.state)).toBe(true);
  });

  test("a valid input is normalized by the tool before the call", async () => {
    const { tool, calls } = fakeTool({ answer: found(["A"]) });
    await run(tool, {
      values: { code: "  1237", on: null },
      uncertainKeys: [],
    });
    expect(calls).toEqual([{ code: "1237", on: null }]);
  });
});

describe("answers", () => {
  test("candidate answers are never auto-selected", async () => {
    await assertProperty(
      "candidate answers are never auto-selected",
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 1,
          maxLength: 10,
        }),
        async (names) => {
          const { tool } = fakeTool({
            match: "candidates",
            cardinality: "many",
            answer: found(names),
          });
          const cell = (
            await run(tool, { values: { code: "17" }, uncertainKeys: [] })
          ).unwrap();
          expect(cell.state).toMatchObject({
            status: "resolved",
            result: { kind: "candidates", selected: null },
          });
        },
      ),
      { seed: propertySeed() },
    );
  });

  test("an exact list is the fact, unselected and possibly empty", async () => {
    const { tool } = fakeTool({ cardinality: "many", answer: found([]) });
    const cell = (
      await run(tool, { values: { code: "7" }, uncertainKeys: [] })
    ).unwrap();
    expect(cell.state).toMatchObject({
      status: "resolved",
      result: { kind: "many", records: [], selected: null },
    });
  });

  test("a one-record tool answering two records is a source failure", async () => {
    const { tool } = fakeTool({ answer: found(["A", "B"]) });
    const outcome = await run(tool, {
      values: { code: "7" },
      uncertainKeys: [],
    });
    expect(outcome.isErr()).toBe(true);
  });

  test("an answer larger than a cell holds is a source failure, never cut", async () => {
    const names = Array.from(
      { length: RECORD_LIMITS.records + 1 },
      (_, index) => `Name ${index}`,
    );
    const { tool } = fakeTool({ cardinality: "many", answer: found(names) });
    const outcome = await run(tool, {
      values: { code: "7" },
      uncertainKeys: [],
    });
    expect(outcome.isErr()).toBe(true);
  });

  test("a record outside the output schema is a source failure", async () => {
    const { tool } = fakeTool({
      answer: {
        type: "records",
        records: [{ name: 3 }],
        url: "https://example.test/",
      },
    });
    const outcome = await run(tool, {
      values: { code: "7" },
      uncertainKeys: [],
    });
    expect(outcome.isErr()).toBe(true);
  });

  test("provenance hashes the canonical records and stamps the run's clock", async () => {
    const { tool } = fakeTool({ answer: found(["Example"]) });
    const cell = (
      await run(tool, { values: { code: "7" }, uncertainKeys: [] })
    ).unwrap();
    expect(cell.schemaVersion).toBe(3);
    expect(cell.state).toMatchObject({
      status: "resolved",
      provenance: {
        url: "https://example.test/source",
        retrievedAt: NOW.toString(),
        sha256: sha256Hex(stableStringify([{ name: "Example" }])),
      },
    });
  });

  test("an unavailable source stays an error, never a stored answer", async () => {
    const { tool } = fakeTool({
      answer: new DataSourceUnavailableError({
        message: "down",
        toolId: "test.fake.lookup",
        reason: "timeout",
      }),
    });
    const outcome = await run(tool, {
      values: { code: "7" },
      uncertainKeys: [],
    });
    expect(outcome.isErr()).toBe(true);
  });
});

describe("cache", () => {
  test("an answer is reused only for the same input, version and window", async () => {
    const { tool } = fakeTool({ answer: found(["A"]) });
    const stored = (
      await run(tool, { values: { code: "7" }, uncertainKeys: [] })
    ).unwrap();
    const input = { code: "7", on: null };
    expect(
      isReusableRecord({ tool, stored, input, now: NOW.add({ hours: 1 }) }),
    ).toBe(true);
    expect(
      isReusableRecord({ tool, stored, input, now: NOW.add({ hours: 2 }) }),
    ).toBe(false);
    expect(
      isReusableRecord({
        tool,
        stored,
        input: { code: "17", on: null },
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isReusableRecord({
        tool,
        stored: { ...stored, schemaVersion: 2 },
        input,
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe("registry", () => {
  test("tool ids are unique, dotted and their schemas are well formed", () => {
    const ids = DATA_SOURCE_TOOLS.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tool of DATA_SOURCE_TOOLS) {
      expect(tool.id).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u);
      expect(tool.output.version).toBeGreaterThanOrEqual(1);
      expect(v.is(recordSchemaSchema, tool.input)).toBe(true);
      expect(v.is(recordSchemaSchema, tool.output.schema)).toBe(true);
    }
  });
});
