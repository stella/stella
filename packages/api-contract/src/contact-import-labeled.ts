export const CONTACT_IMPORT_LABELED_FIELDS = [
  "display_name",
  "tax_id",
  "identity_document",
  "nationality",
  "marital_status",
  "civil_union",
  "occupation",
  "primary_email",
  "address_line_1",
] as const;

export type ContactImportLabeledField =
  (typeof CONTACT_IMPORT_LABELED_FIELDS)[number];

export const CONTACT_IMPORT_VOCABULARIES = {
  "BR:pt-BR": {
    jurisdiction: "BR",
    language: "pt-BR",
    fields: {
      display_name: { labels: ["nome"], persistedLabel: "Nome" },
      tax_id: {
        labels: ["cpf", "cnpj", "cpf/cnpj"],
        persistedLabel: "CPF/CNPJ",
      },
      identity_document: {
        labels: ["rg"],
        persistedLabel: "RG",
      },
      nationality: {
        labels: ["nacionalidade"],
        persistedLabel: "Nacionalidade",
      },
      marital_status: {
        labels: ["estado civil"],
        persistedLabel: "Estado civil",
      },
      civil_union: {
        labels: ["uniao estavel"],
        persistedLabel: "União estável",
      },
      occupation: {
        labels: ["profissao"],
        persistedLabel: "Profissão",
      },
      primary_email: {
        labels: ["email", "e-mail", "e mail"],
        persistedLabel: "E-mail",
      },
      address_line_1: {
        labels: ["endereco"],
        persistedLabel: "Endereço",
      },
    },
  },
} as const satisfies Record<
  string,
  {
    jurisdiction: string;
    language: string;
    fields: Record<
      ContactImportLabeledField,
      { labels: readonly string[]; persistedLabel: string }
    >;
  }
>;

export type ContactImportVocabularyId =
  keyof typeof CONTACT_IMPORT_VOCABULARIES;
