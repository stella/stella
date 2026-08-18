import { describe, expect, test } from "bun:test";

import { candidatesToRows } from "./-parse-procuracao";

describe("procuração candidates", () => {
  test("preserves the AI organization type when no tax ID was extracted", () => {
    const [row] = candidatesToRows([
      {
        nome: "Empresa Sem CNPJ",
        taxId: null,
        rg: null,
        nacionalidade: null,
        estadoCivil: null,
        uniaoEstavel: null,
        profissao: null,
        email: null,
        endereco: null,
        contactType: "organization",
      },
    ]);

    expect(row?.fields.contactType).toBe("organization");
    expect(row?.fieldErrors.nacionalidade).toBeUndefined();
    expect(row?.fieldErrors.estadoCivil).toBeUndefined();
    expect(row?.fieldErrors.profissao).toBeUndefined();
  });
});
