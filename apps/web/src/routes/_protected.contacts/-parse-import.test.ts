import { describe, expect, test } from "bun:test";

import {
  applyContactImportMapping,
  assignStableImportIds,
  contactImportTextFileIssue,
  parseContactImportText,
  toImportRowVars,
  validateRows,
} from "./-parse-import";

const VALID_CONTACT = `Nome: Maria da Silva
CPF: 123.456.789-09
Nacionalidade: brasileira
Estado civil: casada
Profissão: advogada
Email: maria@example.com
Endereço: Rua Um, 10: apto 2`;

describe("labeled contact import", () => {
  test("rejects unsupported or oversized files before parsing", () => {
    expect(
      contactImportTextFileIssue({
        name: "contacts.csv",
        size: 10,
        type: "text/csv",
      }),
    ).toBe("invalid_file_type");
    expect(
      contactImportTextFileIssue({
        name: "contacts.txt",
        size: 1024 * 1024 + 1,
        type: "text/plain",
      }),
    ).toBe("file_too_large");
    expect(
      contactImportTextFileIssue({
        name: "contacts.TXT",
        size: 1024,
        type: "application/octet-stream",
      }),
    ).toBeNull();
  });

  test("matches the Brazilian Portuguese vocabulary and preserves colons in values", () => {
    const [row] = parseContactImportText(VALID_CONTACT);

    expect(row?.blockErrors).toEqual([]);
    expect(row?.fields).toMatchObject({
      nome: "Maria da Silva",
      taxId: "123.456.789-09",
      profissao: "advogada",
      endereco: "Rua Um, 10: apto 2",
      contactType: "person",
    });
  });

  test("lets an unknown label be mapped or ignored", () => {
    const source = `${VALID_CONTACT}\nApelido: Mari`;
    const [unmapped] = parseContactImportText(source);
    expect(unmapped?.blockErrors).toEqual([
      {
        code: "unrecognizedLabel",
        label: "Apelido",
        normalizedLabel: "apelido",
        value: "Mari",
      },
    ]);

    const [mapped] = parseContactImportText(source, {
      mapping: { apelido: "nome" },
    });
    expect(mapped?.blockErrors).toEqual([]);
    expect(mapped?.fields.nome).toBe("Mari");

    const [ignored] = parseContactImportText(source, {
      mapping: { apelido: "ignore" },
    });
    expect(ignored?.blockErrors).toEqual([]);
  });

  test("preserves edits and removed rows when a label is mapped", () => {
    const source = `${VALID_CONTACT}\nApelido: Mari\n\n${VALID_CONTACT.replace("Maria da Silva", "Ana Souza")}\nApelido: Aninha`;
    const initial = assignStableImportIds(parseContactImportText(source));
    const edited = validateRows([
      {
        ...initial[0]!,
        fields: { ...initial[0]!.fields, email: "edited@example.com" },
      },
    ]);

    const mapped = applyContactImportMapping({
      rows: assignStableImportIds(edited, initial),
      sourceText: source,
      mapping: { apelido: "profissao" },
      normalizedLabel: "apelido",
      targetField: "profissao",
    });

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.fields.email).toBe("edited@example.com");
    expect(mapped[0]?.fields.profissao).toBe("Mari");
    expect(mapped[0]?.blockErrors).toEqual([]);
    expect(mapped[0]?.importIds).toBeDefined();
  });

  test("keeps submission identifiers stable across validation and retries", () => {
    const first = assignStableImportIds(parseContactImportText(VALID_CONTACT));
    const second = assignStableImportIds(validateRows(first), first);

    const firstPayload = first.flatMap((row) => {
      const payload = toImportRowVars(row);
      return payload ? [payload] : [];
    });
    const secondPayload = second.flatMap((row) => {
      const payload = toImportRowVars(row);
      return payload ? [payload] : [];
    });

    expect(secondPayload).toEqual(firstPayload);
  });

  test("does not mint submission identifiers for invalid rows", () => {
    const [row] = assignStableImportIds(
      parseContactImportText("Nome: Sem documento"),
    );

    expect(row?.status).toBe("error");
    expect(row?.importIds).toBeUndefined();
    expect(row && toImportRowVars(row)).toBeNull();
  });
});
