import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("field-parts-inside-field", () => {
  test("reports uncovered parts in locally mounted markup", async () => {
    expect(
      await lintSingleRule(
        "field-parts-inside-field",
        'import { FieldDescription, FieldControl } from "@stll/ui/field";\nfunction Row() { return <section><FieldDescription>{hint}</FieldDescription><FieldControl /></section>; }\nfunction Page() { return <main><Row /></main>; }',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([2, 2]);
  });
  test("resolves aliased parts", async () => {
    expect(
      await lintSingleRule(
        "field-parts-inside-field",
        'import { FieldLabel as Label } from "@stll/ui/field";\nfunction Row() { return <section><Label>{name}</Label></section>; }\nfunction Page() { return <main><Row /></main>; }',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([2]);
  });
  test("accepts field ancestors through aliases", async () => {
    expect(
      await lintSingleRule(
        "field-parts-inside-field",
        'import { Field as Root, FieldDescription as Hint } from "@stll/ui/field";\nconst page = <Root><section><Hint>{hint}</Hint></section></Root>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("accepts locally declared field wrappers", async () => {
    expect(
      await lintSingleRule(
        "field-parts-inside-field",
        'import { Field, FieldDescription } from "@stll/ui/field";\nfunction Wrapper({ children }) { return <Field>{children}</Field>; }\nconst page = <Wrapper><FieldDescription>{hint}</FieldDescription></Wrapper>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("leaves imported wrappers and held parts unresolved", async () => {
    expect(
      await lintSingleRule(
        "field-parts-inside-field",
        'import { FieldDescription } from "@stll/ui/field";\nimport { FieldRow } from "./row";\nconst held = <FieldDescription>{hint}</FieldDescription>;\nconst page = <FieldRow><FieldDescription>{hint}</FieldDescription></FieldRow>;',
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
