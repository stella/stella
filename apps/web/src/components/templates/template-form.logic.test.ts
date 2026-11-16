import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ResolvedField } from "./template-discover-types";
import {
  arrayIndexKey,
  buildInitialValues,
  buildSubmitValues,
  groupFieldsByPrefix,
  readAiFieldErrorPaths,
  readClauseWarnings,
  readUndecidedConditionLabels,
  runLeadingSingleFlight,
  savedFillNotices,
  visibleItemFields,
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

describe("download undecided AI conditions", () => {
  test("names each condition by its label, falling back to its path", () => {
    const headers = new Headers({
      "X-Undecided-Conditions": encodeURIComponent(
        JSON.stringify([
          {
            path: "smlouva.spotřebitel",
            label: "Spotřebitelská smlouva — ano/ne",
            reason: "no-backend",
          },
          { path: "has_penalty", label: "", reason: "failed" },
        ]),
      ),
    });
    const result = readUndecidedConditionLabels(headers);
    expect(Result.isOk(result) && result.value).toEqual([
      "Spotřebitelská smlouva — ano/ne",
      "has_penalty",
    ]);
  });

  test("an absent header means every condition was decided", () => {
    const result = readUndecidedConditionLabels(new Headers());
    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  test.each([
    "%",
    "not-json",
    "{}",
    '[{"path":"x","label":"x","reason":"unknown"}]',
    '[{"path":"","label":"x","reason":"failed"}]',
  ])("rejects malformed diagnostics: %s", (encoded) => {
    expect(
      Result.isError(
        readUndecidedConditionLabels(
          new Headers({ "X-Undecided-Conditions": encoded }),
        ),
      ),
    ).toBe(true);
  });
});

describe("notices for a fill saved into a matter", () => {
  const complete = {
    completionStatus: "complete" as const,
    unmatchedPlaceholders: [],
    aiFieldErrors: [],
    undecidedConditions: [],
    structureErrors: [],
  };

  test("a complete fill reports the document as created and nothing else", () => {
    expect(savedFillNotices(complete)).toEqual([{ kind: "created" }]);
  });

  test("a partial fill is reported incomplete, never created, with every reason", () => {
    expect(
      savedFillNotices({
        completionStatus: "partial",
        unmatchedPlaceholders: ["signature", "date"],
        aiFieldErrors: [{ fieldPath: "summary" }],
        undecidedConditions: [
          { path: "is_consumer", label: "Consumer contract" },
          { path: "has_penalty", label: "" },
        ],
        structureErrors: [{}, {}],
      }),
    ).toEqual([
      { kind: "createdIncomplete" },
      { kind: "unmatchedPlaceholders", list: "signature, date" },
      { kind: "aiFieldsNotDrafted", list: "summary" },
      // An empty authored label falls back to the condition's path.
      { kind: "aiConditionsUndecided", list: "Consumer contract, has_penalty" },
      { kind: "structureErrors", count: 2 },
    ]);
  });

  test("a directive that could not be applied alone makes the fill incomplete", () => {
    expect(
      savedFillNotices({
        ...complete,
        completionStatus: "partial",
        structureErrors: [{}],
      }),
    ).toEqual([
      { kind: "createdIncomplete" },
      { kind: "structureErrors", count: 1 },
    ]);
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

describe("download clause diagnostics", () => {
  test.each([0, 1, 10_000, 4_294_967_295])(
    "reads the bounded warning count %s",
    (count) => {
      const result = readClauseWarnings(
        new Headers({ "X-Clause-Warnings": String(count) }),
      );
      expect(result.isOk() && result.value).toBe(count);
      expect(String(count).length).toBeLessThanOrEqual(10);
    },
  );
  test("an absent header means no clause warnings", () => {
    const result = readClauseWarnings(new Headers());
    expect(result.isOk() && result.value).toBe(0);
  });
  test.each([
    "%",
    "null",
    "-1",
    "1.5",
    "01",
    "10000000000",
    '[{"clauseName":"Terms"}]',
  ])("rejects malformed warning counts %s", (encoded) => {
    expect(
      readClauseWarnings(new Headers({ "X-Clause-Warnings": encoded })).isErr(),
    ).toBe(true);
  });
});

describe("per-item field visibility", () => {
  const persons: ResolvedField = {
    path: "persons",
    kind: "array",
    count: 1,
    itemAliases: ["p"],
    itemFields: [
      { path: "vip", kind: "boolean", count: 1 },
      { path: "name", kind: "string", count: 1 },
      { path: "title", kind: "string", count: 1, visibleWhen: "p.vip" },
      { path: "salutation", kind: "string", count: 1, visibleWhen: "vip" },
      { path: "closing", kind: "string", count: 1, visibleWhen: "loop.last" },
      { path: "fee", kind: "string", count: 1, visibleWhen: "show_fees" },
    ],
  };
  const visible = (values: Record<string, unknown>, index: number) =>
    visibleItemFields({
      field: persons,
      index,
      itemCount: 2,
      values,
      conditions: [],
    }).map((sub) => sub.path);

  test("each item asks only for the fields its own branch renders", () => {
    const values = {
      "persons[0].vip": true,
      "persons[1].vip": false,
      show_fees: true,
    };
    expect(visible(values, 0)).toEqual([
      "vip",
      "name",
      "title",
      "salutation",
      "fee",
    ]);
    expect(visible(values, 1)).toEqual(["vip", "name", "closing", "fee"]);
  });

  test("a condition on the document's values applies to every item", () => {
    expect(visible({ show_fees: false }, 0)).toEqual(["vip", "name"]);
  });

  test("an item's own field is read before a document field of the same name", () => {
    expect(visible({ vip: true, "persons[0].vip": false }, 0)).not.toContain(
      "salutation",
    );
    expect(visible({ vip: true }, 0)).toContain("salutation");
  });
});

describe("fill-form value snapshots", () => {
  test("initial values keep scalar defaults and leave repeat indices absent", () => {
    const fields = [
      { path: "name", kind: "string", count: 1 },
      { path: "approved", kind: "boolean", count: 1 },
      { path: "amount", kind: "string", inputType: "number", count: 1 },
      { path: "people", kind: "array", count: 1 },
    ] satisfies ResolvedField[];
    expect(buildInitialValues(fields)).toEqual({
      name: "",
      approved: false,
      amount: "",
    });
  });

  test("submitting nested values copies the path without changing restored values", () => {
    const restoredAddress = { city: "Prague" };
    const fields = [
      { path: "address", kind: "string", count: 1 },
      { path: "address.street", kind: "string", count: 1 },
      { path: "address.number", kind: "string", inputType: "number", count: 1 },
      { path: "approved", kind: "boolean", count: 1 },
      { path: "hidden", kind: "string", visibleWhen: "show_hidden", count: 1 },
      { path: "blank", kind: "string", count: 1 },
    ] satisfies ResolvedField[];
    const values = {
      address: restoredAddress,
      "address.street": "Main",
      "address.number": "12",
      approved: false,
      hidden: "not sent",
      show_hidden: false,
      blank: "",
    };
    const submitted = buildSubmitValues({
      values,
      fields,
      conditionFields: [],
      conditions: [],
    });
    expect(submitted).toEqual({
      address: { city: "Prague", street: "Main", number: 12 },
      approved: false,
    });
    expect(restoredAddress).toEqual({ city: "Prague" });
    expect(submitted["address"]).not.toBe(restoredAddress);
    expect(Object.getPrototypeOf(submitted)).toBeNull();
    expect(Object.getPrototypeOf(submitted["address"])).toBeNull();
  });

  test("repeat containers and item paths stay literal while branches and condition overrides apply", () => {
    const field = {
      path: "signers.people",
      kind: "array",
      count: 1,
      itemAliases: ["p"],
      itemFields: [
        { path: "vip", kind: "boolean", count: 1 },
        { path: "name", kind: "string", count: 1 },
        { path: "address.city", kind: "string", count: 1 },
        { path: "amount", kind: "string", inputType: "number", count: 1 },
        { path: "salutation", kind: "string", visibleWhen: "p.vip", count: 1 },
      ],
    } satisfies ResolvedField;
    const values = {
      [arrayIndexKey(field.path)]: [0, 1],
      "signers.people[0].vip": true,
      "signers.people[0].name": "Ada",
      "signers.people[0].address.city": "Prague",
      "signers.people[0].amount": "3",
      "signers.people[0].salutation": "Dr",
      "signers.people[1].vip": false,
      "signers.people[1].name": "",
      "signers.people[1].salutation": "not sent",
      force_use: false,
    };
    const submitted = buildSubmitValues({
      values,
      fields: [field, { path: "optional.people", kind: "array", count: 1 }],
      conditionFields: [
        { path: "force_use", kind: "boolean", count: 0 },
        { path: "model_owned", kind: "boolean", count: 0 },
      ],
      conditions: [],
    });
    expect(Object.keys(submitted)).toEqual([
      "signers.people",
      "optional.people",
      "force_use",
    ]);
    expect(submitted).toEqual({
      "signers.people": [
        {
          vip: true,
          name: "Ada",
          "address.city": "Prague",
          amount: 3,
          salutation: "Dr",
        },
        { vip: false },
      ],
      "optional.people": [],
      force_use: false,
    });
    const items = submitted["signers.people"];
    expect(Array.isArray(items)).toBe(true);
    if (Array.isArray(items)) {
      expect(items.map((item) => Object.getPrototypeOf(item))).toEqual([
        null,
        null,
      ]);
    }
  });
});

test("deep authored paths rebuild iteratively and trailing-empty paths remain omitted", () => {
  const segments = Array.from(
    { length: 1024 },
    (_, index) => `section${index}`,
  );
  const path = [...segments, "title"].join(".");
  const submitted = buildSubmitValues({
    values: { [path]: "Deep clause", "section.": "not sent" },
    fields: [
      { path, kind: "string", count: 1 },
      { path: "section.", kind: "string", count: 1 },
    ],
    conditionFields: [],
    conditions: [],
  });
  expect(Object.keys(submitted)).toEqual(["section0"]);
  let current: unknown = submitted;
  for (const segment of [...segments, "title"]) {
    if (typeof current !== "object" || current === null) {
      panic("Submitted path ended before its field value");
    }
    expect(Object.getPrototypeOf(current)).toBeNull();
    current = Reflect.get(current, segment);
  }
  expect(current).toBe("Deep clause");
});
