import { describe, expect, test } from "bun:test";

import { omitSourceBoundValues } from "./ai-visible-values";
import type { FieldMeta } from "./types";

const source = {
  kind: "contact",
  field: "taxId",
} as const satisfies NonNullable<FieldMeta["source"]>;

describe("AI-visible template values", () => {
  test("omits flat source-bound values without mutating fill values", () => {
    const values = {
      "client.taxId": "TAX-ID-SECRET-12345",
      scope: "public context",
    };

    const visible = omitSourceBoundValues({
      values,
      fields: [{ path: "client.taxId", source }, { path: "scope" }],
    });

    expect(visible).toEqual({ scope: "public context" });
    expect(values["client.taxId"]).toBe("TAX-ID-SECRET-12345");
  });

  test("omits nested source-bound values", () => {
    const visible = omitSourceBoundValues({
      values: {
        client: {
          taxId: "TAX-ID-SECRET-12345",
          name: "ACME",
        },
      },
      fields: [{ path: "client.taxId", source }],
    });

    expect(visible).toEqual({ client: { name: "ACME" } });
  });

  test("omits source-bound values from every array row", () => {
    const values = {
      clients: [
        { taxId: "TAX-ID-SECRET-12345", name: "ACME" },
        { taxId: "TAX-ID-SECRET-67890", name: "Globex" },
      ],
    };

    const visible = omitSourceBoundValues({
      values,
      fields: [{ path: "clients.taxId", source }],
    });

    expect(visible).toEqual({
      clients: [{ name: "ACME" }, { name: "Globex" }],
    });
    expect(values.clients.at(0)?.taxId).toBe("TAX-ID-SECRET-12345");
  });

  test("omits an unsafe source path from the flat values map", () => {
    const visible = omitSourceBoundValues({
      values: {
        "client[secret]": "TAX-ID-SECRET-12345",
        scope: "public context",
      },
      fields: [{ path: "client[secret]", source }],
    });

    expect(visible).toEqual({ scope: "public context" });
  });
});
