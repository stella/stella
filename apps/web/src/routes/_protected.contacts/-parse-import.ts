import { toSafeId } from "@/lib/safe-id";
import type { SafeId } from "@/lib/safe-id";

export type ParsedImportFieldKey =
  | "nome"
  | "taxId"
  | "rg"
  | "nacionalidade"
  | "estadoCivil"
  | "uniaoEstavel"
  | "profissao"
  | "email"
  | "endereco";

export type ParsedImportRowFields = Record<ParsedImportFieldKey, string> & {
  contactType: "person" | "organization" | null;
};

export type ImportFieldError =
  | { code: "required" }
  | { code: "recommendedMissing" }
  | { code: "invalidTaxIdLength" }
  | { code: "invalidEmailFormat" }
  | { code: "duplicateTaxIdInFile"; firstRowIndex: number };

export type ImportBlockError = { code: "unrecognizedLabel"; label: string };

// "warning" rows have only non-blocking issues (a recommended field left
// empty) and are still included in the submitted batch; "error" rows have
// at least one blocking issue (missing required field, invalid/duplicate
// tax id, or an unrecognized label line) and are excluded until fixed.
export type ParsedImportRowStatus = "ok" | "warning" | "error";

const isBlockingFieldError = (error: ImportFieldError): boolean =>
  error.code !== "recommendedMissing";

export type ParsedImportRow = {
  rowIndex: number;
  status: ParsedImportRowStatus;
  fields: ParsedImportRowFields;
  fieldErrors: Partial<Record<ParsedImportFieldKey, ImportFieldError>>;
  blockErrors: ImportBlockError[];
  rawLines: string[];
};

const LABEL_MAP: Record<string, ParsedImportFieldKey> = {
  nome: "nome",
  cpf: "taxId",
  cnpj: "taxId",
  "cpf/cnpj": "taxId",
  rg: "rg",
  nacionalidade: "nacionalidade",
  "estado civil": "estadoCivil",
  "uniao estavel": "uniaoEstavel",
  profissao: "profissao",
  email: "email",
  "e-mail": "email",
  "e mail": "email",
  endereco: "endereco",
};

const HARD_REQUIRED_FIELDS: ParsedImportFieldKey[] = ["nome", "taxId"];
// Nationality/marital status/occupation only apply to a pessoa física
// (person) outorgante; a pessoa jurídica (organization, CNPJ) has none of
// these, so they must not be flagged as missing for organization rows.
const PERSON_ONLY_SOFT_REQUIRED_FIELDS: ParsedImportFieldKey[] = [
  "nacionalidade",
  "estadoCivil",
  "profissao",
];
const UNIVERSAL_SOFT_REQUIRED_FIELDS: ParsedImportFieldKey[] = [
  "email",
  "endereco",
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const onlyDigits = (value: string): string => value.replaceAll(/\D/gu, "");

const DIACRITIC_MARKS_PATTERN = /[\u0300-\u036f]/gu;

const normalizeLabel = (raw: string): string =>
  raw
    .normalize("NFD")
    .replaceAll(DIACRITIC_MARKS_PATTERN, "")
    .trim()
    .toLowerCase();

const emptyFields = (): ParsedImportRowFields => ({
  nome: "",
  taxId: "",
  rg: "",
  nacionalidade: "",
  estadoCivil: "",
  uniaoEstavel: "",
  profissao: "",
  email: "",
  endereco: "",
  contactType: null,
});

const splitBlocks = (text: string): string[][] =>
  text
    .replaceAll("\r\n", "\n")
    .split(/\n\s*\n+/u)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    )
    .filter((lines) => lines.length > 0);

const extractFields = (
  rawLines: string[],
): { fields: ParsedImportRowFields; blockErrors: ImportBlockError[] } => {
  const fields = emptyFields();
  const blockErrors: ImportBlockError[] = [];

  for (const line of rawLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      blockErrors.push({ code: "unrecognizedLabel", label: line });
      continue;
    }

    const rawLabel = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    const fieldKey = LABEL_MAP[normalizeLabel(rawLabel)];

    if (!fieldKey) {
      blockErrors.push({ code: "unrecognizedLabel", label: rawLabel });
      continue;
    }

    fields[fieldKey] = rawValue;
  }

  return { fields, blockErrors };
};

const validateFields = (
  fields: ParsedImportRowFields,
  rowIndex: number,
  taxIdFirstSeen: Map<string, number>,
): {
  fields: ParsedImportRowFields;
  fieldErrors: Partial<Record<ParsedImportFieldKey, ImportFieldError>>;
} => {
  const fieldErrors: Partial<Record<ParsedImportFieldKey, ImportFieldError>> =
    {};

  for (const key of HARD_REQUIRED_FIELDS) {
    if (!fields[key]) {
      fieldErrors[key] = { code: "required" };
    }
  }

  let contactType: "person" | "organization" | null = null;
  if (fields.taxId) {
    const digits = onlyDigits(fields.taxId);
    if (digits.length === 11) {
      contactType = "person";
    } else if (digits.length === 14) {
      contactType = "organization";
    } else {
      fieldErrors.taxId = { code: "invalidTaxIdLength" };
    }

    if (contactType) {
      const firstRowIndex = taxIdFirstSeen.get(digits);
      if (firstRowIndex !== undefined && firstRowIndex !== rowIndex) {
        fieldErrors.taxId = {
          code: "duplicateTaxIdInFile",
          firstRowIndex,
        };
      } else if (firstRowIndex === undefined) {
        taxIdFirstSeen.set(digits, rowIndex);
      }
    }
  }

  for (const key of UNIVERSAL_SOFT_REQUIRED_FIELDS) {
    if (!fields[key]) {
      fieldErrors[key] = { code: "recommendedMissing" };
    }
  }

  if (contactType !== "organization") {
    for (const key of PERSON_ONLY_SOFT_REQUIRED_FIELDS) {
      if (!fields[key]) {
        fieldErrors[key] = { code: "recommendedMissing" };
      }
    }
  }

  if (fields.email && !EMAIL_PATTERN.test(fields.email)) {
    fieldErrors.email = { code: "invalidEmailFormat" };
  }

  return { fields: { ...fields, contactType }, fieldErrors };
};

/**
 * Recompute status/fieldErrors for every row from its current `fields` and
 * `blockErrors` — called both by the initial parse and by the preview
 * dialog after an inline edit, so duplicate-taxId and per-field checks stay
 * consistent across the whole batch as the user fixes rows.
 */
export const validateRows = (
  rows: {
    rowIndex: number;
    fields: ParsedImportRowFields;
    blockErrors: ImportBlockError[];
    rawLines: string[];
  }[],
): ParsedImportRow[] => {
  const taxIdFirstSeen = new Map<string, number>();

  return rows.map(({ rowIndex, fields, blockErrors, rawLines }) => {
    const validated = validateFields(fields, rowIndex, taxIdFirstSeen);
    const fieldErrorList = Object.values(validated.fieldErrors);
    const hasBlockingFieldError = fieldErrorList.some(isBlockingFieldError);

    let status: ParsedImportRowStatus = "ok";
    if (hasBlockingFieldError || blockErrors.length > 0) {
      status = "error";
    } else if (fieldErrorList.length > 0) {
      status = "warning";
    }

    return {
      rowIndex,
      status,
      fields: validated.fields,
      fieldErrors: validated.fieldErrors,
      blockErrors,
      rawLines,
    };
  });
};

export const parseContactImportText = (text: string): ParsedImportRow[] => {
  const blocks = splitBlocks(text);
  const extracted = blocks.map((rawLines, rowIndex) => {
    const { fields, blockErrors } = extractFields(rawLines);
    return { rowIndex, fields, blockErrors, rawLines };
  });

  return validateRows(extracted);
};

type ContactEmailVars = {
  type: "work" | "personal" | "other";
  address: string;
  isPrimary: boolean;
};

type ContactAddressVars = {
  type:
    | "office"
    | "mailing"
    | "billing"
    | "service"
    | "home"
    | "other";
  line1: string;
  isPrimary: boolean;
};

type ContactCustomFieldVars = {
  id: string;
  label: string;
  value: string;
};

export type ImportContactRowVars = {
  id: SafeId<"contact">;
  displayName: string;
  taxId: string;
  emails?: ContactEmailVars[];
  addresses?: ContactAddressVars[];
  metadata?: { customFields: ContactCustomFieldVars[] };
};

const CUSTOM_FIELD_LABELS: {
  key: Extract<
    ParsedImportFieldKey,
    "rg" | "nacionalidade" | "estadoCivil" | "uniaoEstavel" | "profissao"
  >;
  label: string;
}[] = [
  { key: "rg", label: "RG" },
  { key: "nacionalidade", label: "Nacionalidade" },
  { key: "estadoCivil", label: "Estado civil" },
  { key: "uniaoEstavel", label: "União estável" },
  { key: "profissao", label: "Profissão" },
];

export const toImportRowVars = (
  row: ParsedImportRow,
): ImportContactRowVars | null => {
  if (row.status === "error") {
    return null;
  }

  const { fields } = row;

  const customFields = CUSTOM_FIELD_LABELS.filter(
    ({ key }) => fields[key],
  ).map(({ key, label }) => ({
    id: crypto.randomUUID(),
    label,
    value: fields[key],
  }));

  return {
    id: toSafeId<"contact">(crypto.randomUUID()),
    displayName: fields.nome,
    taxId: onlyDigits(fields.taxId),
    ...(fields.email && {
      emails: [
        { type: "work" as const, address: fields.email, isPrimary: true },
      ],
    }),
    ...(fields.endereco && {
      addresses: [
        { type: "home" as const, line1: fields.endereco, isPrimary: true },
      ],
    }),
    ...(customFields.length > 0 && { metadata: { customFields } }),
  };
};
