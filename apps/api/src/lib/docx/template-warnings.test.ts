import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "./discover-template";
import {
  fieldOverlayWarnings,
  type RegistryGate,
  TEMPLATE_WARNING_CODES,
  type TemplateWarningCode,
} from "./template-warnings";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body></w:document>`;

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (documentXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file("word/document.xml", documentXml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

/** Gates that stand in for the org's native-tool settings. `refuseAll` also
 *  records that it ran, so a test can prove the settings read is skipped when
 *  no field declares a lookup. */
const allowAll: RegistryGate = async () => () => true;
const refuseAll = (): RegistryGate & { calls: () => number } => {
  let calls = 0;
  const gate = async () => {
    calls++;
    return () => false;
  };
  return Object.assign(gate, { calls: () => calls });
};

describe("field overlay warnings", () => {
  // `is_signed` drives {{#if is_signed}} AND prints as {{is_signed}}.
  const bothRoles = {
    conditionPaths: ["is_signed"],
    placeholderPaths: ["is_signed", "client.name"],
    registryGate: allowAll,
  };
  const SIGNED_RULE = 'status == "signed"';

  test("a condition on a path the document also prints removes its input", async () => {
    expect(
      await fieldOverlayWarnings({
        ...bothRoles,
        fields: [{ path: "is_signed", condition: SIGNED_RULE }],
      }),
    ).toEqual([
      {
        code: "condition_removes_input",
        path: "is_signed",
        message: expect.stringContaining("{{is_signed}}"),
        hint: expect.stringContaining("Drop the condition"),
      },
    ]);
  });

  test("a condition on a path used only by {{#if}} is the intended use", async () => {
    expect(
      await fieldOverlayWarnings({
        conditionPaths: ["is_signed"],
        placeholderPaths: ["client.name"],
        registryGate: allowAll,
        fields: [{ path: "is_signed", condition: SIGNED_RULE }],
      }),
    ).toEqual([]);
  });

  test("a plain boolean field keeps its input and warns about nothing", async () => {
    expect(
      await fieldOverlayWarnings({
        ...bothRoles,
        fields: [{ path: "is_signed" }],
      }),
    ).toEqual([]);
  });

  test("an AST-backed condition is derived the same way", async () => {
    expect(
      (
        await fieldOverlayWarnings({
          ...bothRoles,
          fields: [
            {
              path: "is_signed",
              conditionAst: { type: "predicate", op: "is_truthy" },
            },
          ],
        })
      ).map(({ code }) => code),
    ).toEqual(["condition_removes_input"]);
  });
});

describe("lookup field warnings", () => {
  const lookupField = {
    path: "company",
    lookup: {
      registry: "krs",
      formats: [{ key: "default" }, { key: "address" }],
    },
  } as const;

  test("a registry the organization has not enabled is reported", async () => {
    const gate = refuseAll();
    const warnings = await fieldOverlayWarnings({
      conditionPaths: [],
      placeholderPaths: ["company", "company.address"],
      fields: [lookupField],
      registryGate: gate,
    });

    expect(warnings).toEqual([
      {
        code: "registry_disabled",
        path: "company",
        message: expect.stringContaining("krs"),
        hint: expect.stringContaining("Enable that registry"),
      },
    ]);
    expect(gate.calls()).toBe(1);
  });

  test("no lookup field means no settings read", async () => {
    const gate = refuseAll();
    await fieldOverlayWarnings({
      conditionPaths: [],
      placeholderPaths: ["client.name"],
      fields: [{ path: "client.name" }],
      registryGate: gate,
    });

    expect(gate.calls()).toBe(0);
  });

  test("a declared format with no marker, and a marker with no format, are both reported", async () => {
    const warnings = await fieldOverlayWarnings({
      conditionPaths: [],
      // `company.address` is declared but unplaced; `company.seat` is placed
      // but undeclared. The default format rides the bare `{{company}}`.
      placeholderPaths: ["company", "company.seat"],
      fields: [lookupField],
      registryGate: allowAll,
    });

    expect(warnings).toEqual([
      {
        code: "unmatched_lookup_format",
        path: "company.address",
        message: expect.stringContaining("renders nowhere"),
        hint: expect.stringContaining("{{company.address}}"),
      },
      {
        code: "unmatched_lookup_format",
        path: "company.seat",
        message: expect.stringContaining("names no format"),
        hint: expect.stringContaining('"seat" format'),
      },
    ]);
  });

  test("a first format placed by the bare marker needs no keyed marker", async () => {
    expect(
      await fieldOverlayWarnings({
        conditionPaths: [],
        placeholderPaths: ["company", "company.address"],
        fields: [lookupField],
        registryGate: allowAll,
      }),
    ).toEqual([]);
  });

  test("the first format is addressed by the bare marker or its declared key", async () => {
    const placed = async (placeholderPaths: readonly string[]) =>
      await fieldOverlayWarnings({
        conditionPaths: [],
        placeholderPaths,
        fields: [
          {
            path: "company",
            lookup: { registry: "krs", formats: [{ key: "default" }] },
          },
        ],
        registryGate: allowAll,
      });

    expect(await placed(["company"])).toEqual([]);
    expect(await placed(["company.default"])).toEqual([]);
    expect(await placed(["company", "company.value"])).toEqual([
      expect.objectContaining({
        code: "unmatched_lookup_format",
        path: "company.value",
      }),
    ]);
    expect((await placed(["client.name"])).map(({ code }) => code)).toEqual([
      "unmatched_lookup_format",
    ]);
  });

  test("a template that addresses every format by key, bare marker included, is clean", async () => {
    // The bilingual case: `company` carries no marker of its own, and each
    // format key IS a marker. Every format still renders, from one lookup, so
    // there is nothing to warn about.
    expect(
      await fieldOverlayWarnings({
        conditionPaths: [],
        placeholderPaths: ["company.krs", "company.name"],
        fields: [
          {
            path: "company",
            lookup: {
              registry: "krs",
              formats: [{ key: "name" }, { key: "krs" }],
            },
          },
        ],
        registryGate: allowAll,
      }),
    ).toEqual([]);
  });
});

// A code nobody can produce is dead guidance, and a producible code with no
// fixture is untested: both directions are asserted, so adding a code without
// a template that triggers it fails here.
describe("warning code census", () => {
  test("every declared code is produced by a template that triggers it", async () => {
    const xml = WRAP(
      [
        P("{{#if is_signed}}"),
        P("Signed by {{is_signed}}"),
        P("{{/if}}"),
        P("{{company}} of {{company.seat}}"),
        P("{{#each attorneys}}"),
        P("{{name}}"),
        P("{{this.name}}"),
        P("{{attorneys[0].name}}"),
        P("{{#endeach}}"),
        P("Name: {{unclosed"),
      ].join(""),
    );
    const discovered = await discoverTemplate(await makeDocx(xml));

    const produced = new Set<TemplateWarningCode>([
      ...discovered.warnings.map(({ code }) => code),
      ...(
        await fieldOverlayWarnings({
          conditionPaths: discovered.conditionPaths,
          placeholderPaths: discovered.placeholders.map(({ name }) => name),
          fields: [
            { path: "is_signed", condition: 'status == "signed"' },
            {
              path: "company",
              lookup: {
                registry: "krs",
                formats: [{ key: "default" }, { key: "address" }],
              },
            },
          ],
          registryGate: refuseAll(),
        })
      ).map(({ code }) => code),
    ]);

    expect([...produced].toSorted()).toEqual(
      [...TEMPLATE_WARNING_CODES].toSorted(),
    );
  });
});
