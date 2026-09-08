import { describe, expect, test } from "bun:test";

import type { NamedCondition } from "@stll/template-conditions";

import {
  manifestFieldsFromMerge,
  mergeManifestWithDiscovery,
} from "./template-manifest";
import type { DiscoveredTemplate, TemplateManifest } from "./types";

// ── mergeManifestWithDiscovery ───────────────────────────

describe("mergeManifestWithDiscovery", () => {
  const baseDiscovery: DiscoveredTemplate = {
    placeholders: [
      { name: "clientName", count: 2 },
      { name: "date", count: 1 },
      { name: "amount", count: 1 },
    ],
    fields: [
      {
        path: "clientName",
        kind: "string",
        count: 2,
      },
      { path: "date", kind: "string", count: 1 },
      { path: "amount", kind: "string", count: 1 },
      {
        path: "showClause",
        kind: "boolean",
        count: 1,
      },
    ],
    structureErrors: [],
    warnings: [],
    conditionPaths: [],
    documentFields: [],
    loopAliases: [],
  };

  test("returns discovered fields when no manifest", () => {
    const resolved = mergeManifestWithDiscovery(null, baseDiscovery);
    expect(resolved).toHaveLength(4);
    expect(resolved[0]?.path).toBe("clientName");
    expect(resolved[0]?.kind).toBe("string");
    expect(resolved[0]?.count).toBe(2);
  });

  test("enriches discovered fields with manifest metadata", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "clientName",
          label: "Client Name",
          inputType: "text",
          required: true,
        },
        {
          path: "date",
          label: "Contract Date",
          inputType: "date",
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const clientField = resolved.find((f) => f.path === "clientName");
    expect(clientField?.label).toBe("Client Name");
    expect(clientField?.inputType).toBe("text");
    expect(clientField?.required).toBe(true);
    expect(clientField?.kind).toBe("string");
    expect(clientField?.count).toBe(2);

    const dateField = resolved.find((f) => f.path === "date");
    expect(dateField?.label).toBe("Contract Date");
    expect(dateField?.inputType).toBe("date");
  });

  test("includes manifest-only fields not found by discovery", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "hiddenField",
          label: "Hidden",
          inputType: "text",
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const hidden = resolved.find((f) => f.path === "hiddenField");
    expect(hidden).toBeDefined();
    expect(hidden?.label).toBe("Hidden");
    expect(hidden?.count).toBe(0);
  });

  test("threads formula through to resolved fields", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        { path: "rent", kind: "string", count: 1 },
        { path: "rent_annual", kind: "string", count: 1 },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        { path: "rent_annual", formula: "rent * 12" },
        { path: "manifest_only", formula: "rent * 24" },
      ],
    };
    const resolved = mergeManifestWithDiscovery(manifest, discovery);
    const discoveredField = resolved.find((f) => f.path === "rent_annual");
    const manifestOnly = resolved.find((f) => f.path === "manifest_only");
    expect(discoveredField?.formula).toBe("rent * 12");
    expect(manifestOnly?.formula).toBe("rent * 24");
    expect(resolved.find((f) => f.path === "rent")?.formula).toBeUndefined();
  });

  test("carries a manifest binding onto a field discovered in the document", () => {
    // A placeholder discovered in the document (count > 0) whose manifest entry
    // declares a `source` must keep that binding after the merge; without
    // mergeField copying `source`, a discovered bound field loses its binding.
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [{ path: "client_name", kind: "string", count: 2 }],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "client_name",
          source: { kind: "contact", field: "displayName" },
        },
      ],
    };
    const resolved = mergeManifestWithDiscovery(manifest, discovery);
    const discoveredField = resolved.find((f) => f.path === "client_name");
    expect(discoveredField?.count).toBe(2);
    expect(discoveredField?.source).toEqual({
      kind: "contact",
      field: "displayName",
    });
  });

  test("drops namespace parents (a path that is only a prefix of others)", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        { path: "tenant", kind: "object", count: 0 },
        { path: "tenant.name", kind: "string", count: 1 },
        { path: "tenant.krs", kind: "string", count: 1 },
        { path: "rent", kind: "string", count: 1 },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const resolved = mergeManifestWithDiscovery(null, discovery);
    expect(resolved.map((f) => f.path).sort()).toEqual([
      "rent",
      "tenant.krs",
      "tenant.name",
    ]);
  });

  test("keeps a loop item's configuration as its own manifest field", () => {
    // `{% for attorney in attorneys %}{{ attorney.name }}{% endfor %}` resolves to ONE field,
    // the array root, with `name` folded into its itemFields. The item's own
    // configuration is a manifest field all the same — the fill form asks it
    // once per row — so building the manifest from the resolved list alone
    // discarded every label, hint, input type and validation set on it.
    const discovery: DiscoveredTemplate = {
      placeholders: [
        { name: "attorneys.name", count: 1 },
        { name: "attorneys.role", count: 1 },
      ],
      fields: [
        {
          path: "attorneys",
          kind: "array",
          count: 2,
          itemFields: [
            { path: "name", kind: "string", count: 1 },
            { path: "role", kind: "string", count: 1 },
          ],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        { path: "attorneys", validation: { minItems: 1 } },
        { path: "attorneys.name", label: "Attorney name", required: true },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovery);
    // The merge itself still reports one field: the item lives in itemFields.
    expect(resolved.map((f) => f.path)).toEqual(["attorneys"]);

    const fields = manifestFieldsFromMerge(resolved, manifest);
    expect(fields.map((f) => f.path)).toEqual(["attorneys", "attorneys.name"]);
    expect(fields.at(1)).toEqual({
      path: "attorneys.name",
      label: "Attorney name",
      required: true,
    });
  });

  test("does not carry a lookup's format marker back as a field", () => {
    // The item carry-back must not resurrect what the prefix filter dropped on
    // purpose: `deliverables.company.name` is a rendering, not an input.
    const discovery: DiscoveredTemplate = {
      placeholders: [
        { name: "deliverables.company", count: 1 },
        { name: "deliverables.company.name", count: 1 },
      ],
      fields: [
        {
          path: "deliverables",
          kind: "array",
          count: 1,
          itemFields: [{ path: "company", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "deliverables.company",
          lookup: {
            registry: "krs",
            formats: [{ key: "name", template: "[company name]" }],
          },
        },
        { path: "deliverables.company.name", label: "leftover" },
      ],
    };

    const fields = manifestFieldsFromMerge(
      mergeManifestWithDiscovery(manifest, discovery),
      manifest,
    );
    expect(fields.map((f) => f.path)).toEqual([
      "deliverables",
      "deliverables.company",
    ]);
  });

  test("keeps a parent the document writes as its own marker", () => {
    // `{{tenant}}` alongside `{{tenant.name}}` is not a namespace: the
    // document prints `tenant` itself. Dropping it left the marker with no
    // field behind it, so the fill emitted the literal `{{tenant}}` text.
    const discovery: DiscoveredTemplate = {
      placeholders: [
        { name: "tenant", count: 1 },
        { name: "tenant.name", count: 1 },
      ],
      fields: [
        { path: "tenant", kind: "object", count: 1 },
        { path: "tenant.name", kind: "string", count: 1 },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const resolved = mergeManifestWithDiscovery(null, discovery);
    expect(resolved.map((f) => f.path).toSorted()).toEqual([
      "tenant",
      "tenant.name",
    ]);
  });

  test("keeps parent arrays when nested loop paths share their prefix", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "contracts",
          kind: "array",
          count: 1,
          itemFields: [{ path: "name", kind: "string", count: 1 }],
        },
        {
          path: "contracts.fields",
          kind: "array",
          count: 1,
          itemFields: [{ path: "value", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };

    const resolved = mergeManifestWithDiscovery(null, discovery);

    expect(resolved.map((field) => field.path).toSorted()).toEqual([
      "contracts",
      "contracts.fields",
    ]);
    expect(
      resolved.find((field) => field.path === "contracts")?.itemFields,
    ).toEqual([{ path: "name", kind: "string", count: 1 }]);
  });

  test("keeps a lookup field as a leaf despite dotted format markers under it", () => {
    // {{company}} + {{company.full}} make discovery promote `company` to an
    // object and register `company.full` as a string. The lookup field is a
    // real leaf input, so it must survive the namespace-parent filter, and its
    // declared format markers must be dropped (rendered outputs, not inputs).
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "company",
          lookup: {
            registry: "krs",
            formats: [{ key: "full", template: "[company name], [seat]" }],
          },
        },
      ],
    };
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        { path: "company", kind: "object", count: 1 },
        { path: "company.full", kind: "string", count: 1 },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const resolved = mergeManifestWithDiscovery(manifest, discovery);
    expect(resolved.map((f) => f.path)).toEqual(["company"]);
    expect(resolved.at(0)?.lookup?.formats).toEqual([
      { key: "full", template: "[company name], [seat]" },
    ]);
  });

  test("preserves discovered fields without manifest entries", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "clientName",
          label: "Client Name",
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const amount = resolved.find((f) => f.path === "amount");
    expect(amount).toBeDefined();
    expect(amount?.kind).toBe("string");
    expect(amount?.label).toBeUndefined();
  });

  test("preserves item fields for array types", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "items",
          kind: "array",
          count: 1,
          itemFields: [
            {
              path: "name",
              kind: "string",
              count: 1,
            },
            {
              path: "price",
              kind: "string",
              count: 1,
            },
          ],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };

    const resolved = mergeManifestWithDiscovery(null, discovery);

    expect(resolved[0]?.itemFields).toHaveLength(2);
    expect(resolved[0]?.itemFields?.[0]?.path).toBe("name");
  });

  test("dotted manifest entries enrich array item fields without shadowing the array root", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "lawyers",
          kind: "array",
          count: 1,
          itemFields: [{ path: "name", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "lawyers.name",
          label: "Lawyer name",
          inputType: "text",
          required: true,
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovery);

    // The array root must survive (a flat "lawyers.name" field would shadow
    // it in the namespace-parent filter and break the array fill form).
    expect(resolved).toHaveLength(1);
    const lawyers = resolved.at(0);
    expect(lawyers?.path).toBe("lawyers");
    expect(lawyers?.kind).toBe("array");
    const item = lawyers?.itemFields?.at(0);
    expect(item?.path).toBe("name");
    expect(item?.label).toBe("Lawyer name");
    expect(item?.inputType).toBe("text");
    expect(item?.required).toBe(true);
  });

  test("manifest entries under an array root never emit flat fields, even unplaced ones", () => {
    const discovery: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "lawyers",
          kind: "array",
          count: 1,
          itemFields: [{ path: "name", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "lawyers.email", label: "Email", inputType: "text" }],
    };

    const resolved = mergeManifestWithDiscovery(manifest, discovery);

    expect(resolved).toHaveLength(1);
    expect(resolved.at(0)?.path).toBe("lawyers");
    expect(resolved.at(0)?.kind).toBe("array");
  });

  test("merge preserves empty-string label from manifest", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [{ path: "clientName", label: "" }],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const clientField = resolved.find((f) => f.path === "clientName");
    expect(clientField?.label).toBe("");
  });

  test("manifest select options are preserved", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "amount",
          label: "Amount",
          inputType: "select",
          options: ["100", "200", "500"],
        },
      ],
    };

    const resolved = mergeManifestWithDiscovery(manifest, baseDiscovery);

    const amount = resolved.find((f) => f.path === "amount");
    expect(amount?.inputType).toBe("select");
    expect(amount?.options).toEqual(["100", "200", "500"]);
  });
});

// ── Named conditions integration ─────────────────────────

describe("named conditions in fillTemplate", () => {
  test("evaluateCondition resolves named conditions", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: 'contractType == "NDA"',
      },
    ];

    const data = { contractType: "NDA" };
    expect(evaluateCondition("HasNDA", data, conditions)).toBe(true);

    const data2 = { contractType: "SLA" };
    expect(evaluateCondition("HasNDA", data2, conditions)).toBe(false);
  });

  test("named condition falls back to normal evaluation", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: "contractType",
      },
    ];

    // Expression that doesn't match any named condition
    const data = { showSection: true };
    expect(evaluateCondition("showSection", data, conditions)).toBe(true);
  });

  test("named conditions work without namedConditions param", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const data = { active: true };
    expect(evaluateCondition("active", data)).toBe(true);
    expect(evaluateCondition("active", data)).toBe(true);
  });

  test("circular named conditions return false", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      { name: "A", expression: "B" },
      { name: "B", expression: "A" },
    ];

    const data = {};
    expect(evaluateCondition("A", data, conditions)).toBe(false);
  });

  test("named conditions resolve in negated expressions", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: 'contractType == "NDA"',
      },
    ];

    const data = { contractType: "NDA" };
    expect(evaluateCondition("not HasNDA", data, conditions)).toBe(false);

    const data2 = { contractType: "SLA" };
    expect(evaluateCondition("not HasNDA", data2, conditions)).toBe(true);
  });

  test("named conditions resolve in compound expressions", async () => {
    const { evaluateCondition } = await import("./block-directives");

    const conditions: NamedCondition[] = [
      {
        name: "HasNDA",
        expression: 'contractType == "NDA"',
      },
    ];

    const data = { contractType: "NDA", isActive: true };
    expect(evaluateCondition("HasNDA and isActive", data, conditions)).toBe(
      true,
    );

    const data2 = { contractType: "SLA", isActive: true };
    expect(evaluateCondition("HasNDA or isActive", data2, conditions)).toBe(
      true,
    );
    expect(evaluateCondition("HasNDA and isActive", data2, conditions)).toBe(
      false,
    );
  });
  test("shared sub-conditions don't trigger false circular detection", async () => {
    const { evaluateCondition } = await import("./block-directives");

    // IsNDA is used by both IsPremium (directly) and
    // IsLongTerm (indirectly). The _resolved set must not
    // leak across sibling resolutions.
    const conditions: NamedCondition[] = [
      {
        name: "IsPremium",
        expression: "IsNDA and IsLongTerm",
      },
      {
        name: "IsNDA",
        expression: 'contractType == "NDA"',
      },
      {
        name: "IsLongTerm",
        expression: "IsNDA and duration > 12",
      },
    ];

    const data = { contractType: "NDA", duration: 24 };
    expect(evaluateCondition("IsPremium", data, conditions)).toBe(true);

    const data2 = { contractType: "NDA", duration: 6 };
    expect(evaluateCondition("IsPremium", data2, conditions)).toBe(false);
  });
});

// ── Configuration the merge carries through ──────────────

/**
 * A property configured on a marker reaches the resolved field, whether the
 * document also declares the path (discovery found it) or only the manifest
 * carries it. The manifest is derived from the markers, so a property the
 * merge drops is a property the fill form never asks about.
 */
describe("a configured property reaches the resolved field", () => {
  const declaring = (path: string): DiscoveredTemplate => ({
    placeholders: [{ name: path, count: 1 }],
    fields: [{ path, kind: "string", count: 1 }],
    structureErrors: [],
    warnings: [],
    conditionPaths: [],
    documentFields: [],
    loopAliases: [],
  });

  test.each([
    ["optionsFrom", { inputType: "select", optionsFrom: "parties" }],
    ["hint", { hint: 'KRS <number> from the "register"' }],
    [
      "dateFormat",
      { inputType: "date", dateFormat: { locale: "cs", style: "long" } },
    ],
    [
      "lookup",
      {
        lookup: {
          registry: "krs",
          formats: [{ key: "output_1", template: "[name]" }],
        },
      },
    ],
  ] as [string, Omit<TemplateManifest["fields"][number], "path">][])(
    "%s survives, on a discovered path and on one only the manifest names",
    (_property, configuration) => {
      const manifest: TemplateManifest = {
        version: 1,
        fields: [
          { path: "declared", ...configuration },
          { path: "manifest_only", ...configuration },
        ],
      };

      const resolved = mergeManifestWithDiscovery(
        manifest,
        declaring("declared"),
      );

      for (const path of ["declared", "manifest_only"]) {
        expect(resolved.find((field) => field.path === path)).toMatchObject(
          configuration,
        );
      }
    },
  );

  test("a path the manifest says nothing about carries no configuration", () => {
    const resolved = mergeManifestWithDiscovery(
      { version: 1, fields: [{ path: "declared" }] },
      declaring("declared"),
    );

    expect(resolved.find((field) => field.path === "declared")).toEqual({
      path: "declared",
      kind: "string",
      count: 1,
    });
  });

  test("an array's item counts reach the array root, which keeps its items", () => {
    const manifest: TemplateManifest = {
      version: 1,
      fields: [
        {
          path: "lawyers",
          label: "Lawyers",
          validation: { minItems: 1, maxItems: 3 },
        },
      ],
    };
    const discovered: DiscoveredTemplate = {
      placeholders: [],
      fields: [
        {
          path: "lawyers",
          kind: "array",
          count: 1,
          itemFields: [{ path: "name", kind: "string", count: 1 }],
        },
      ],
      structureErrors: [],
      warnings: [],
      conditionPaths: [],
      documentFields: [],
      loopAliases: [],
    };

    const lawyers = mergeManifestWithDiscovery(manifest, discovered).find(
      (field) => field.path === "lawyers",
    );

    expect(lawyers?.kind).toBe("array");
    expect(lawyers?.label).toBe("Lawyers");
    expect(lawyers?.validation).toEqual({ minItems: 1, maxItems: 3 });
    // The array root must survive the namespace-parent filter.
    expect(lawyers?.itemFields).toHaveLength(1);
  });
});
