import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { discoverTemplate } from "@/api/lib/docx/discover-template";
import type { FieldMeta } from "@/api/lib/docx/types";

import {
  applyFieldOverlay,
  resolveTemplateFieldOverlay,
  validateFieldOverlay,
} from "./field-overlay";

const P = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

const makeDocx = async (...paragraphs: string[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${paragraphs.map(P).join("")}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `</Types>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

const krsLookup = (...keys: string[]): FieldMeta["lookup"] => ({
  registry: "krs",
  formats: keys.map((key) => ({ key, template: "[company name]" })),
});

describe("validateFieldOverlay", () => {
  test("accepts a lookup on the parent of dotted markers", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // The parent has no marker of its own: the format keys ARE the markers.
    expect(discovered.placeholders.map((p) => p.name)).not.toContain("company");

    expect(
      validateFieldOverlay({
        configured: [],
        discovered,
        overlay: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("accepts a lookup on a parent that also has its own marker", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company}}", "{{company.krs}}"),
    );

    expect(
      validateFieldOverlay({
        configured: [],
        discovered,
        overlay: [{ path: "company", lookup: krsLookup("default", "krs") }],
      }),
    ).toEqual([]);
  });

  test("rejects a namespace parent configured as an ordinary field", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "company.name", label: "Name" },
        { path: "company", label: "Company" },
      ],
    });

    // The leaf marker stays configurable; only the structural parent is refused.
    expect(issues.map(({ path }) => path)).toEqual(["fields.1"]);
    expect(issues.at(0)?.message).toContain("{{company.name}}");
    expect(issues.at(0)?.message).toContain("{{company.krs}}");
  });

  test("accepts a repeat's root and the item paths inside it", async () => {
    const discovered = await discoverTemplate(
      await makeDocx(
        "{{#each attorneys}}",
        "{{attorneys.name}} of {{attorneys.firm}}",
        "{{/each}}",
      ),
    );

    // The array root is a value-bearing input (min_items, max_items), and each
    // item path is a field the fill form asks once per row.
    expect(
      validateFieldOverlay({
        configured: [],
        discovered,
        overlay: [
          { path: "attorneys", validation: { minItems: 1 } },
          { path: "attorneys.name", label: "Attorney name", required: true },
          { path: "attorneys.firm", inputType: "text" },
        ],
      }),
    ).toEqual([]);
  });

  test("rejects a path with no marker at all", async () => {
    const discovered = await discoverTemplate(await makeDocx("{{company}}"));

    const issues = validateFieldOverlay({
      configured: [],
      discovered,
      overlay: [{ path: "company" }, { path: "ghost", label: "Ghost" }],
    });

    expect(issues).toEqual([
      {
        path: "fields.1",
        message:
          "No marker {{ghost}} in the DOCX. Configure only paths that exist " +
          "as {{markers}}.",
      },
    ]);
  });

  test("rejects a lookup format key that collides with a configured field", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldOverlay({
      configured: [],
      discovered,
      overlay: [
        { path: "company", lookup: krsLookup("name", "krs") },
        { path: "company.name", inputType: "text", label: "Company name" },
      ],
    });

    // Both sides of the collision are named, each at its own entry index.
    expect(issues.map(({ path }) => path)).toEqual(["fields.0", "fields.1"]);
    for (const { message } of issues) {
      expect(message).toContain('"company"');
      expect(message).toContain('"company.name"');
    }
  });

  test("rejects a lookup colliding with an already-configured child", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    const issues = validateFieldOverlay({
      configured: [{ path: "company.name", inputType: "text" }],
      discovered,
      overlay: [{ path: "company", lookup: krsLookup("name", "krs") }],
    });

    expect(issues.map(({ path }) => path)).toEqual(["fields.0"]);
  });

  test("a bare discovered child entry is a marker, not a rival configuration", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.krs}}"),
    );

    // Creation records every discovered marker in the manifest as `{ path }`.
    // That is not an authored decision, so a later lookup may claim it.
    expect(
      validateFieldOverlay({
        configured: [{ path: "company.name" }, { path: "company.krs" }],
        discovered,
        overlay: [{ path: "company", lookup: krsLookup("name", "krs") }],
      }),
    ).toEqual([]);
  });

  test("lookup ownership is enforced across every split of existing and incoming configuration", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const owner = { path: "company", lookup: krsLookup("name") };
    const child = { path: "company.name", label: "Legal name" };
    for (const { configured, overlay } of [
      { configured: [owner], overlay: [child] },
      { configured: [child], overlay: [owner] },
      { configured: [], overlay: [owner, child] },
      { configured: [], overlay: [child, owner] },
    ]) {
      const issues = validateFieldOverlay({ configured, discovered, overlay });
      expect(new Set(issues.map(({ path }) => path))).toEqual(
        new Set(overlay.map((_, index) => `fields.${index}`)),
      );
      for (const { message } of issues) {
        expect(message).toContain('"company"');
        expect(message).toContain('"company.name"');
      }
    }
  });

  test("an existing lookup can be relabelled or release a previously owned format", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}", "{{company.full}}"),
    );
    const configured = [{ path: "company", lookup: krsLookup("name") }];
    for (const overlay of [
      [{ path: "company", label: "Legal entity" }],
      [
        { path: "company", lookup: krsLookup("full") },
        { path: "company.name", label: "Separate name" },
      ],
    ]) {
      expect(validateFieldOverlay({ configured, discovered, overlay })).toEqual(
        [],
      );
    }
  });

  test("duplicate overlay paths are rejected whether the field already exists or is newly discovered", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const field = { path: "company", lookup: krsLookup("name") };
    for (const configured of [[], [field]]) {
      const issues = validateFieldOverlay({
        configured,
        discovered,
        overlay: [field, field],
      });
      expect(issues).toEqual([
        expect.objectContaining({
          path: "fields.1",
          message: expect.stringContaining("duplicate"),
        }),
      ]);
    }
  });
});

describe("applyFieldOverlay", () => {
  test("new and embedded lookup configurations resolve the same manifest for storage and diagnostics", async () => {
    const discovered = await discoverTemplate(
      await makeDocx("{{company.name}}"),
    );
    const lookup = { path: "company", lookup: krsLookup("name") };
    const incoming = resolveTemplateFieldOverlay({
      discovered,
      manifest: null,
      overlay: [lookup],
    });
    const embedded = resolveTemplateFieldOverlay({
      discovered,
      manifest: incoming,
      overlay: undefined,
    });
    expect(incoming).toEqual(embedded);
    expect(incoming.fields).toEqual([expect.objectContaining(lookup)]);
    expect(incoming.fields.map(({ path }) => path)).toEqual(["company"]);
  });

  test("merges by path and appends a path the manifest does not carry", () => {
    const manifest = {
      version: 1,
      fields: [
        { path: "company.name", label: "Name" },
        { path: "signed_on", inputType: "date" as const },
      ],
    };

    expect(
      applyFieldOverlay(manifest, [
        { path: "signed_on", label: "Signature date" },
        { path: "company", lookup: krsLookup("name") },
      ]),
    ).toEqual({
      version: 1,
      fields: [
        { path: "company.name", label: "Name" },
        { path: "signed_on", inputType: "date", label: "Signature date" },
        { path: "company", lookup: krsLookup("name") },
      ],
    });
  });

  test("starts a manifest from the overlay when the template has none", () => {
    expect(applyFieldOverlay(null, [{ path: "fee", label: "Fee" }])).toEqual({
      version: 1,
      fields: [{ path: "fee", label: "Fee" }],
    });
  });
});
