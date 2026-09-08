import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ResolvedField } from "./template-discover-types";
import {
  groupFieldsByPrefix,
  readAiFieldErrorPaths,
  runLeadingSingleFlight,
} from "./template-form.logic";

describe("download AI diagnostics", () => {
  test("preserves field paths across URI-encoded JSON, including multilingual paths", () => {
    const paths = ["pełnomocnictwo.zakres", "مهمة", "scope,english"];
    const headers = new Headers({
      "X-Ai-Field-Errors": encodeURIComponent(
        JSON.stringify(
          paths.map((fieldPath) => ({ fieldPath, error: "failed" })),
        ),
      ),
    });
    const result = readAiFieldErrorPaths(headers);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(paths);
    }
  });

  test("an absent diagnostic header means no failed drafts", () => {
    const result = readAiFieldErrorPaths(new Headers());
    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  test.each([
    "%",
    "not-json",
    "null",
    "{}",
    '[{"fieldPath":1}]',
    '[{"fieldPath":""}]',
  ])("rejects malformed diagnostics: %s", (encoded) => {
    expect(
      Result.isError(
        readAiFieldErrorPaths(
          new Headers({
            "X-Ai-Field-Errors": encoded,
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe("runLeadingSingleFlight", () => {
  test("coalesces every concurrent caller into one operation", async () => {
    const state: { current: Promise<void> | null } = { current: null };
    let calls = 0;
    const operation = async () => {
      calls += 1;
    };

    const concurrent = Array.from({ length: 100 }, async () => {
      await runLeadingSingleFlight(state, operation);
    });

    expect(calls).toBe(1);
    await Promise.all(concurrent);

    await runLeadingSingleFlight(state, operation);
    expect(calls).toBe(2);
  });

  test("releases the gate after rejection", async () => {
    const state: { current: Promise<void> | null } = { current: null };
    let shouldReject = true;
    const operation = async () => {
      if (shouldReject) {
        throw new Error("expected operation failure");
      }
    };

    const rejection = await runLeadingSingleFlight(state, operation).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toBe(
      "expected operation failure",
    );
    shouldReject = false;

    await runLeadingSingleFlight(state, operation);
    expect(state.current).toBeNull();
  });
});

describe("fill-form grouping", () => {
  const field = (path: string, label?: string): ResolvedField => ({
    path,
    kind: "string",
    count: 1,
    ...(label === undefined ? {} : { label }),
  });

  test("titles a group with the parent field's label when the template fills it", () => {
    const groups = groupFieldsByPrefix([
      field("landlord", "Landlord"),
      field("landlord.name"),
      field("note"),
    ]);

    expect(groups).toEqual([
      {
        kind: "named",
        prefix: "landlord",
        legend: "Landlord",
        fields: [field("landlord", "Landlord"), field("landlord.name")],
        children: [field("landlord.name")],
      },
      { kind: "ungrouped", fields: [field("note")] },
    ]);
  });

  test("falls back to the authored prefix without a labelled parent", () => {
    const groups = groupFieldsByPrefix([
      field("tenant.name"),
      field("tenant", "   "),
    ]);

    expect(groups.at(0)).toMatchObject({ legend: "tenant" });
  });

  test("keeps the parent field out of the registry-autofill scope", () => {
    const groups = groupFieldsByPrefix([field("seat"), field("seat.city")]);

    expect(groups.at(0)).toMatchObject({
      fields: [field("seat"), field("seat.city")],
      children: [field("seat.city")],
    });
  });

  test("groups nothing when no path is dotted", () => {
    expect(groupFieldsByPrefix([field("a"), field("b")])).toEqual([
      { kind: "ungrouped", fields: [field("a"), field("b")] },
    ]);
  });
});
