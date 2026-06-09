import { describe, expect, test } from "bun:test";

import {
  applyCompositeFields,
  renderCompositeFormat,
  resolveCompositeFields,
} from "./composite-fields";
import type { FieldMeta } from "./types";

const lawyerField: FieldMeta = {
  path: "lawyer",
  label: "Lawyer",
  parts: [
    {
      key: "position",
      inputType: "select",
      options: ["rad. praw.", "adw."],
    },
    { key: "name", inputType: "text" },
  ],
  format: "{{position}} {{name}}",
};

describe("resolveCompositeFields", () => {
  test("joins valid parts via the format", () => {
    const result = resolveCompositeFields({
      values: { lawyer: { position: "rad. praw.", name: "Jan Kowalski" } },
      fields: [lawyerField],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["lawyer"]).toBe("rad. praw. Jan Kowalski");
    }
  });

  test("rejects a select part value outside its options", () => {
    const result = resolveCompositeFields({
      values: { lawyer: { position: "dr hab.", name: "Jan Kowalski" } },
      fields: [lawyerField],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe("lawyer");
      expect(result.errors[0]?.partKey).toBe("position");
      expect(result.errors[0]?.message).toContain("rad. praw.");
    }
  });

  test("rejects a part value that fails its anchored pattern", () => {
    const field: FieldMeta = {
      path: "case_ref",
      parts: [
        { key: "court", inputType: "text" },
        { key: "number", inputType: "text", pattern: "\\d+/\\d{4}" },
      ],
      format: "{{court}} {{number}}",
    };

    const rejected = resolveCompositeFields({
      values: { case_ref: { court: "SO Warszawa", number: "x123/2026x" } },
      fields: [field],
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors[0]?.partKey).toBe("number");
    }

    const accepted = resolveCompositeFields({
      values: { case_ref: { court: "SO Warszawa", number: "123/2026" } },
      fields: [field],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.values["case_ref"]).toBe("SO Warszawa 123/2026");
    }
  });

  test("a plain string value passes through unchanged", () => {
    const result = resolveCompositeFields({
      values: { lawyer: "adw. Anna Nowak" },
      fields: [lawyerField],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["lawyer"]).toBe("adw. Anna Nowak");
    }
  });

  test("rejects when a part value is missing", () => {
    const result = resolveCompositeFields({
      values: { lawyer: { position: "adw." } },
      fields: [lawyerField],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.partKey).toBe("name");
      expect(result.errors[0]?.message).toContain('"lawyer"');
      expect(result.errors[0]?.message).toContain('"name"');
    }
  });

  test("rejects unknown part keys", () => {
    const result = resolveCompositeFields({
      values: {
        lawyer: { position: "adw.", name: "Jan Kowalski", extra: "x" },
      },
      fields: [lawyerField],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.partKey).toBe("extra");
    }
  });

  test("an absent value is left for unmatched diagnostics", () => {
    const result = resolveCompositeFields({
      values: { other: "x" },
      fields: [lawyerField],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["lawyer"]).toBeUndefined();
    }
  });

  test("resolves a nested object value at a dotted path", () => {
    const field: FieldMeta = { ...lawyerField, path: "counsel.lead" };
    const result = resolveCompositeFields({
      values: {
        counsel: { lead: { position: "adw.", name: "Anna Nowak" } },
      },
      fields: [field],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["counsel"]).toEqual({ lead: "adw. Anna Nowak" });
    }
  });

  test("resolves a flat dotted key", () => {
    const field: FieldMeta = { ...lawyerField, path: "counsel.lead" };
    const result = resolveCompositeFields({
      values: {
        "counsel.lead": { position: "adw.", name: "Anna Nowak" },
      },
      fields: [field],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values["counsel.lead"]).toBe("adw. Anna Nowak");
    }
  });
});

describe("applyCompositeFields", () => {
  test("assembles values in place and returns null", () => {
    const values: Record<string, unknown> = {
      lawyer: { position: "adw.", name: "Anna Nowak" },
    };
    expect(applyCompositeFields(values, { fields: [lawyerField] })).toBeNull();
    expect(values["lawyer"]).toBe("adw. Anna Nowak");
  });

  test("returns one message naming every failing field and part", () => {
    const values: Record<string, unknown> = { lawyer: { position: "adw." } };
    const message = applyCompositeFields(values, { fields: [lawyerField] });
    expect(message).toContain('"lawyer"');
    expect(message).toContain('"name"');
  });

  test("is a no-op without a manifest", () => {
    const values: Record<string, unknown> = { lawyer: { position: "adw." } };
    expect(applyCompositeFields(values, null)).toBeNull();
    expect(values["lawyer"]).toEqual({ position: "adw." });
  });
});

describe("renderCompositeFormat", () => {
  test("leaves markers without a matching part key untouched", () => {
    expect(
      renderCompositeFormat("{{position}} {{typo}}", { position: "adw." }),
    ).toBe("adw. {{typo}}");
  });
});
