import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
  CONTACT_IMPORT_LABELED_FIELDS,
  CONTACT_IMPORT_MAX_ROWS,
  CONTACT_IMPORT_SCHEMA_VERSION,
  CONTACT_IMPORT_VOCABULARIES,
  type ContactImportLabeledField,
  type ContactImportTargetField,
} from "@stll/api-contract";

import { contactCustomFieldSchema } from "@/api/db/schema-validators";
import {
  inspectContactImportDocument,
  parseContactImportDocument,
  previewContactImport,
  suggestedTargetForHeader,
  validateContactImportCandidate,
} from "@/api/handlers/contacts/contact-import-file";
import type { ContactImportCandidate } from "@/api/handlers/contacts/contact-import-file";

const parseDocument = (text: string) => {
  const result = parseContactImportDocument(text);
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

type PreviewMapping = Omit<
  Parameters<typeof previewContactImport>[0]["mapping"],
  "version"
>;

const preview = (text: string, mapping: PreviewMapping) => {
  const result = previewContactImport({
    document: parseDocument(text),
    mapping: { version: CONTACT_IMPORT_SCHEMA_VERSION, ...mapping },
  });
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

// A checksum-valid CPF (person) and CNPJ (organization); the third fails the
// CPF check digits, so it is a tax id no Brazilian registry ever issued.
const VALID_CPF = "123.456.789-09";
const VALID_CNPJ = "11.222.333/0001-81";
const INVALID_CPF = "123.456.789-00";

const LABELED_BLOCKS = [
  "Nome: João da Silva",
  "CPF/CNPJ: 123.456.789-09",
  "RG: 12.345.678-9",
  "Nacionalidade: brasileiro",
  "Estado civil: casado",
  "Profissão: engenheiro",
  "E-mail: joao@example.com",
  "Endereço: Rua A, 123",
  "",
  "Nome: Acme Ltda",
  "CPF/CNPJ: 11.222.333/0001-81",
  "E-mail: contato@acme.com",
].join("\n");

describe("contact import document", () => {
  test("parses quoted headers after a UTF-8 BOM", () => {
    const document = parseDocument(
      '\uFEFF"Name","Email"\n"Jane Doe","jane@example.com"',
    );

    expect(document.headers).toEqual(["Name", "Email"]);
    expect(document.rows).toEqual([["Jane Doe", "jane@example.com"]]);
  });

  test("detects a semicolon file and suggests each destination once", () => {
    const document = parseDocument(
      "Jméno;E-mail;E-mail\nJan Novák;jan@example.com;other@example.com",
    );

    expect(inspectContactImportDocument(document)).toMatchObject({
      delimiter: "semicolon",
      rowCount: 1,
      taxIdScheme: "none",
      columns: [
        { sourceIndex: 0, targetField: "display_name" },
        { sourceIndex: 1, targetField: "primary_email" },
        { sourceIndex: 2, targetField: "ignore" },
      ],
    });
  });

  test("rejects files whose delimiter is ambiguous", () => {
    const result = parseContactImportDocument(
      "Name, legal;Email\nAcme, s.r.o.;a@example.com",
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("rejects rows beyond the import bound without parsing the suffix", () => {
    const rows = Array.from(
      { length: CONTACT_IMPORT_MAX_ROWS + 1 },
      (_, index) => `Contact ${index}`,
    );
    const result = parseContactImportDocument(
      `Name\n${rows.join("\n")}\n"unterminated`,
    );

    expect(Result.isError(result)).toBe(true);
  });

  test("previews normalized contacts and reports invalid rows", () => {
    const result = preview(
      "First name,Last name,Email\nJane,Doe,jane@example.com\nBroken,Email,not-an-email",
      {
        defaultType: "person",
        generateDisplayName: true,
        taxIdScheme: "none",
        columns: [
          { sourceIndex: 0, targetField: "first_name" },
          { sourceIndex: 1, targetField: "last_name" },
          { sourceIndex: 2, targetField: "primary_email" },
        ],
      },
    );

    expect(result).toMatchObject({
      validCount: 1,
      errorCount: 1,
      rows: [
        {
          rowNumber: 2,
          contact: { displayName: "Jane Doe", type: "person" },
          issues: [],
        },
        {
          rowNumber: 3,
          contact: { displayName: "Broken Email", type: "person" },
          issues: [{ code: "invalid_email", field: "primary_email" }],
        },
      ],
    });
  });

  test("rejects mapping one destination more than once", () => {
    const result = previewContactImport({
      document: parseDocument("First,Second\nJane,Doe"),
      mapping: {
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        defaultType: "person",
        generateDisplayName: true,
        taxIdScheme: "none",
        columns: [
          { sourceIndex: 0, targetField: "first_name" },
          { sourceIndex: 1, targetField: "first_name" },
        ],
      },
    });

    expect(Result.isError(result)).toBe(true);
  });
});

describe("labeled contact import blocks", () => {
  test("reads blocks as rows and first-seen labels as columns", () => {
    const document = parseDocument(LABELED_BLOCKS);

    expect(document.headers).toEqual([
      "Nome",
      "CPF/CNPJ",
      "RG",
      "Nacionalidade",
      "Estado civil",
      "Profissão",
      "E-mail",
      "Endereço",
    ]);
    expect(document.rows).toEqual([
      [
        "João da Silva",
        VALID_CPF,
        "12.345.678-9",
        "brasileiro",
        "casado",
        "engenheiro",
        "joao@example.com",
        "Rua A, 123",
      ],
      ["Acme Ltda", VALID_CNPJ, "", "", "", "", "contato@acme.com", ""],
    ]);
  });

  test("collapses labels that alias one field into a single column", () => {
    const document = parseDocument(
      `Nome: Pessoa\nCPF: ${VALID_CPF}\nEmail: p@example.com\n\nNome: Empresa\nCNPJ: ${VALID_CNPJ}\nE-mail: e@example.com`,
    );

    // CPF and CNPJ both alias tax_id; Email and E-mail both alias
    // primary_email. Each pair must land in one column, headed by the first
    // spelling seen, so no block leaves a half-empty duplicate column behind.
    expect(document.headers).toEqual(["Nome", "CPF", "Email"]);
    expect(document.rows).toEqual([
      ["Pessoa", VALID_CPF, "p@example.com"],
      ["Empresa", VALID_CNPJ, "e@example.com"],
    ]);
  });

  test("reads a single block with no blank-line separator", () => {
    const document = parseDocument("Nome: Solo\nCPF/CNPJ: 123.456.789-09");

    expect(document.headers).toEqual(["Nome", "CPF/CNPJ"]);
    expect(document.rows).toEqual([["Solo", VALID_CPF]]);
  });

  test("keeps reading a real two-column CSV as a table", () => {
    const document = parseDocument("Name,Email\nJane,jane@example.com");

    expect(inspectContactImportDocument(document)).toMatchObject({
      delimiter: "comma",
    });
  });

  test("suggests first-class fields, custom fields, and ignores the rest", () => {
    const document = parseDocument(
      `${LABELED_BLOCKS}\n\nNome: Third\nCPF/CNPJ: 123.456.789-09\nCor favorita: azul`,
    );

    expect(inspectContactImportDocument(document)).toMatchObject({
      delimiter: "labeled",
      rowCount: 3,
      taxIdScheme: "br_cpf_cnpj",
      generateDisplayName: false,
      columns: [
        { name: "Nome", targetField: "display_name" },
        { name: "CPF/CNPJ", targetField: "tax_id" },
        { name: "RG", targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION },
        {
          name: "Nacionalidade",
          targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
        },
        {
          name: "Estado civil",
          targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
        },
        {
          name: "Profissão",
          targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
        },
        { name: "E-mail", targetField: "primary_email" },
        { name: "Endereço", targetField: "address_line_1" },
        { name: "Cor favorita", targetField: "ignore" },
      ],
    });
  });

  test("every vocabulary label resolves to its declared destination", () => {
    const expected = {
      display_name: "display_name",
      tax_id: "tax_id",
      identity_document: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
      nationality: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
      marital_status: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
      civil_union: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
      occupation: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
      primary_email: "primary_email",
      address_line_1: "address_line_1",
    } as const satisfies Record<
      ContactImportLabeledField,
      ContactImportTargetField
    >;

    for (const vocabulary of Object.values(CONTACT_IMPORT_VOCABULARIES)) {
      for (const field of CONTACT_IMPORT_LABELED_FIELDS) {
        for (const label of vocabulary.fields[field].labels) {
          expect([label, suggestedTargetForHeader(label)]).toEqual([
            label,
            expected[field],
          ]);
        }
      }
    }
  });
});

describe("custom field columns", () => {
  const labeledCustomFieldMapping = {
    defaultType: "person",
    generateDisplayName: false,
    taxIdScheme: "none",
    columns: [
      { sourceIndex: 0, targetField: "display_name" },
      { sourceIndex: 2, targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION },
      { sourceIndex: 3, targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION },
    ],
  } satisfies PreviewMapping;

  test("lands each non-empty cell in metadata.customFields under its header", () => {
    const result = preview(LABELED_BLOCKS, labeledCustomFieldMapping);

    expect(result.rows.at(0)?.contact.metadata).toEqual({
      customFields: [
        { id: "rg-2", label: "RG", value: "12.345.678-9" },
        { id: "nacionalidade-3", label: "Nacionalidade", value: "brasileiro" },
      ],
    });
    // The organization block leaves both custom columns empty, so it carries
    // no metadata at all rather than empty-valued custom fields.
    expect(result.rows.at(1)?.contact.metadata).toBeUndefined();
    expect(result.errorCount).toBe(0);
  });

  test("flags a custom field value the contact schema could not store", () => {
    const valueLimit = contactCustomFieldSchema.properties.value.maxLength ?? 0;
    expect(valueLimit).toBeGreaterThan(0);
    const result = preview(`Nome: Long\nRG: ${"9".repeat(valueLimit + 1)}`, {
      defaultType: "person",
      generateDisplayName: false,
      taxIdScheme: "none",
      columns: [
        { sourceIndex: 0, targetField: "display_name" },
        {
          sourceIndex: 1,
          targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
        },
      ],
    });

    // A labeled document has no header line, so its first block is row 1.
    expect(result.rows.at(0)?.issues).toEqual([
      { code: "too_long", field: null, rowNumber: 1 },
    ]);
  });

  test("numbers delimited rows from the line under the header", () => {
    const result = preview("Name\nJane\nJohn", {
      defaultType: "person",
      generateDisplayName: false,
      taxIdScheme: "none",
      columns: [{ sourceIndex: 0, targetField: "display_name" }],
    });

    expect(result.rows.map(({ rowNumber }) => rowNumber)).toEqual([2, 3]);
  });

  test("rejects a mapping whose custom field label exceeds the schema bound", () => {
    const labelLimit = contactCustomFieldSchema.properties.label.maxLength ?? 0;
    expect(labelLimit).toBeGreaterThan(0);
    const header = "L".repeat(labelLimit + 1);
    const result = previewContactImport({
      document: parseDocument(`${header},Value\nfirst,second`),
      mapping: {
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        defaultType: "person",
        generateDisplayName: false,
        taxIdScheme: "none",
        columns: [
          {
            sourceIndex: 0,
            targetField: CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
          },
          { sourceIndex: 1, targetField: "display_name" },
        ],
      },
    });

    expect(Result.isError(result)).toBe(true);
  });
});

describe("brazilian tax id scheme", () => {
  const columns = [
    { sourceIndex: 0, targetField: "display_name" },
    { sourceIndex: 1, targetField: "tax_id" },
  ] as const;

  test("stores bare digits and derives the type when no type column is mapped", () => {
    const result = preview(
      `Nome,CPF/CNPJ\nJoão,${VALID_CPF}\nAcme,${VALID_CNPJ}`,
      {
        defaultType: "person",
        generateDisplayName: false,
        taxIdScheme: "br_cpf_cnpj",
        columns: [...columns],
      },
    );

    expect(result.errorCount).toBe(0);
    expect(result.rows.map(({ contact }) => contact)).toMatchObject([
      { type: "person", taxId: "12345678909" },
      { type: "organization", taxId: "11222333000181" },
    ]);
  });

  test("reports a checksum-invalid tax id", () => {
    const result = preview(`Nome,CPF/CNPJ\nJoão,${INVALID_CPF}`, {
      defaultType: "person",
      generateDisplayName: false,
      taxIdScheme: "br_cpf_cnpj",
      columns: [...columns],
    });

    expect(result.rows.at(0)?.issues).toEqual([
      { code: "invalid_tax_id", field: "tax_id", rowNumber: 2 },
    ]);
  });

  test("reports a mapped type that contradicts the tax id", () => {
    const result = preview(
      `Nome,CPF/CNPJ,Type\nJoão,${VALID_CNPJ},person\nAcme,${VALID_CNPJ},organization`,
      {
        defaultType: "person",
        generateDisplayName: false,
        taxIdScheme: "br_cpf_cnpj",
        columns: [...columns, { sourceIndex: 2, targetField: "type" }],
      },
    );

    expect(result.rows.at(0)?.issues).toEqual([
      { code: "invalid_tax_id", field: "tax_id", rowNumber: 2 },
    ]);
    expect(result.rows.at(1)?.issues).toEqual([]);
  });

  test("keeps the raw value when the scheme is none", () => {
    const result = preview(`Nome,CPF/CNPJ\nJoão,${INVALID_CPF}`, {
      defaultType: "organization",
      generateDisplayName: false,
      taxIdScheme: "none",
      columns: [...columns],
    });

    expect(result.rows.at(0)).toMatchObject({
      issues: [],
      contact: { type: "organization", taxId: INVALID_CPF },
    });
  });
});

describe("candidate validation", () => {
  const candidate = (
    overrides: Partial<ContactImportCandidate> = {},
  ): ContactImportCandidate => ({
    type: "person",
    displayName: "João da Silva",
    taxId: VALID_CPF,
    ...overrides,
  });

  test("normalizes a valid tax id without touching the input", () => {
    const input = candidate();
    const { contact, issues } = validateContactImportCandidate({
      candidate: input,
      taxIdScheme: "br_cpf_cnpj",
      rowNumber: 1,
    });

    expect(issues).toEqual([]);
    expect(contact.taxId).toBe("12345678909");
    expect(input.taxId).toBe(VALID_CPF);
  });

  test("requires a tax id under a checksum scheme, not under none", () => {
    const missing = candidate({ taxId: undefined });

    expect(
      validateContactImportCandidate({
        candidate: missing,
        taxIdScheme: "br_cpf_cnpj",
        rowNumber: 2,
      }).issues,
    ).toEqual([{ code: "tax_id_required", field: "tax_id", rowNumber: 2 }]);
    expect(
      validateContactImportCandidate({
        candidate: missing,
        taxIdScheme: "none",
        rowNumber: 2,
      }).issues,
    ).toEqual([]);
  });

  test("reports a checksum-invalid tax id and keeps the value", () => {
    const { contact, issues } = validateContactImportCandidate({
      candidate: candidate({ taxId: INVALID_CPF }),
      taxIdScheme: "br_cpf_cnpj",
      rowNumber: 4,
    });

    expect(issues).toEqual([
      { code: "invalid_tax_id", field: "tax_id", rowNumber: 4 },
    ]);
    expect(contact.taxId).toBe(INVALID_CPF);
  });

  test("reports a type that contradicts the tax id kind", () => {
    const { issues } = validateContactImportCandidate({
      candidate: candidate({ taxId: VALID_CNPJ }),
      taxIdScheme: "br_cpf_cnpj",
      rowNumber: 2,
    });

    expect(issues).toEqual([
      { code: "invalid_tax_id", field: "tax_id", rowNumber: 2 },
    ]);
  });

  test("reports an address with no street line", () => {
    const { issues } = validateContactImportCandidate({
      candidate: candidate({
        taxId: undefined,
        addresses: [
          { type: "office", line1: "", city: "Prague", isPrimary: true },
        ],
      }),
      taxIdScheme: "none",
      rowNumber: 3,
    });

    expect(issues).toEqual([
      { code: "address_line_required", field: "address_line_1", rowNumber: 3 },
    ]);
  });

  test("reports a custom field value the contact schema could not store", () => {
    const valueLimit = contactCustomFieldSchema.properties.value.maxLength ?? 0;
    const { issues } = validateContactImportCandidate({
      candidate: candidate({
        metadata: {
          customFields: [
            { id: "rg-1", label: "RG", value: "9".repeat(valueLimit + 1) },
          ],
        },
      }),
      taxIdScheme: "none",
      rowNumber: 5,
    });

    expect(issues).toEqual([{ code: "too_long", field: null, rowNumber: 5 }]);
  });

  test("reports an empty display name and an unusable email", () => {
    const { issues } = validateContactImportCandidate({
      candidate: candidate({
        displayName: "",
        emails: [{ type: "work", address: "not-an-email", isPrimary: true }],
      }),
      taxIdScheme: "none",
      rowNumber: 6,
    });

    expect(issues).toEqual([
      { code: "display_name_required", field: "display_name", rowNumber: 6 },
      { code: "invalid_email", field: "primary_email", rowNumber: 6 },
    ]);
  });
});
