import {
  CONTACT_IMPORT_LABELED_FIELDS,
  CONTACT_IMPORT_VOCABULARIES,
  type ContactImportLabeledField,
  type ContactImportVocabularyId,
} from "@stll/api-contract";

import type { ImportContactRowVars } from "@/lib/contacts/import-types";
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

export type ImportBlockError = {
  code: "unrecognizedLabel";
  label: string;
  normalizedLabel: string;
  value: string;
};

export type LabeledImportMapping = Record<
  string,
  ParsedImportFieldKey | "ignore"
>;

export const DEFAULT_CONTACT_IMPORT_VOCABULARY_ID =
  "BR:pt-BR" satisfies ContactImportVocabularyId;

const CONTACT_IMPORT_TEXT_MAX_BYTES = 1024 * 1024;

export const contactImportTextFileIssue = (
  file: Pick<File, "name" | "size" | "type">,
): "file_too_large" | "invalid_file_type" | null => {
  if (!file.name.toLowerCase().endsWith(".txt")) {
    return "invalid_file_type";
  }
  if (file.size > CONTACT_IMPORT_TEXT_MAX_BYTES) {
    return "file_too_large";
  }
  return null;
};

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
  importIds?: ImportRowIds;
};

type CustomFieldKey = Extract<
  ParsedImportFieldKey,
  "rg" | "nacionalidade" | "estadoCivil" | "uniaoEstavel" | "profissao"
>;

type ImportRowIds = {
  contactId: SafeId<"contact">;
  customFieldIds: Record<CustomFieldKey, string>;
};

const PARSED_FIELD_FOR_CANONICAL = {
  display_name: "nome",
  tax_id: "taxId",
  identity_document: "rg",
  nationality: "nacionalidade",
  marital_status: "estadoCivil",
  civil_union: "uniaoEstavel",
  occupation: "profissao",
  primary_email: "email",
  address_line_1: "endereco",
} as const satisfies Record<ContactImportLabeledField, ParsedImportFieldKey>;

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

const hasBasicEmailFormat = (value: string): boolean => {
  const atIndex = value.indexOf("@");
  if (
    atIndex <= 0 ||
    atIndex !== value.lastIndexOf("@") ||
    atIndex === value.length - 1
  ) {
    return false;
  }
  for (const character of value) {
    if (character.trim().length === 0) {
      return false;
    }
  }

  const domain = value.slice(atIndex + 1);
  const dotIndex = domain.indexOf(".");
  return dotIndex > 0 && dotIndex < domain.length - 1;
};

const onlyDigits = (value: string): string => value.replaceAll(/\D/gu, "");

const DIACRITIC_MARKS_PATTERN = /[\u0300-\u036f]/gu;

const normalizeLabel = (raw: string): string =>
  raw
    .normalize("NFD")
    .replaceAll(DIACRITIC_MARKS_PATTERN, "")
    .trim()
    .toLowerCase();

const vocabularyLabelMap = (
  vocabularyId: ContactImportVocabularyId,
): Readonly<Record<string, ParsedImportFieldKey>> => {
  const result: Record<string, ParsedImportFieldKey> = {};
  const vocabulary = CONTACT_IMPORT_VOCABULARIES[vocabularyId];

  for (const field of CONTACT_IMPORT_LABELED_FIELDS) {
    for (const label of vocabulary.fields[field].labels) {
      result[normalizeLabel(label)] = PARSED_FIELD_FOR_CANONICAL[field];
    }
  }
  return result;
};

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

const splitBlocks = (text: string): string[][] => {
  const blocks: string[][] = [];
  let block: string[] = [];

  for (const rawLine of text.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length > 0) {
      block.push(line);
      continue;
    }
    if (block.length > 0) {
      blocks.push(block);
      block = [];
    }
  }

  if (block.length > 0) {
    blocks.push(block);
  }
  return blocks;
};

const extractFields = (
  rawLines: string[],
  mapping: LabeledImportMapping,
  vocabularyId: ContactImportVocabularyId,
): { fields: ParsedImportRowFields; blockErrors: ImportBlockError[] } => {
  const fields = emptyFields();
  const blockErrors: ImportBlockError[] = [];
  const knownLabels = vocabularyLabelMap(vocabularyId);

  for (const line of rawLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      blockErrors.push({
        code: "unrecognizedLabel",
        label: line,
        normalizedLabel: normalizeLabel(line),
        value: "",
      });
      continue;
    }

    const rawLabel = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    const normalizedLabel = normalizeLabel(rawLabel);
    const fieldKey = mapping[normalizedLabel] ?? knownLabels[normalizedLabel];

    if (fieldKey === "ignore") {
      continue;
    }

    if (!fieldKey) {
      blockErrors.push({
        code: "unrecognizedLabel",
        label: rawLabel,
        normalizedLabel,
        value: rawValue,
      });
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

  let contactType = fields.contactType;
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

  if (fields.email && !hasBasicEmailFormat(fields.email)) {
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

export const parseContactImportText = (
  text: string,
  {
    mapping = {},
    vocabularyId = DEFAULT_CONTACT_IMPORT_VOCABULARY_ID,
  }: {
    mapping?: LabeledImportMapping;
    vocabularyId?: ContactImportVocabularyId;
  } = {},
): ParsedImportRow[] => {
  const blocks = splitBlocks(text);
  const extracted = blocks.map((rawLines, rowIndex) => {
    const { fields, blockErrors } = extractFields(
      rawLines,
      mapping,
      vocabularyId,
    );
    return { rowIndex, fields, blockErrors, rawLines };
  });

  return validateRows(extracted);
};

type ApplyContactImportMappingOptions = {
  rows: readonly ParsedImportRow[];
  sourceText: string;
  mapping: LabeledImportMapping;
  normalizedLabel: string;
  targetField: ParsedImportFieldKey | "ignore";
};

/** Apply one new label mapping without resetting edits or restoring removed rows. */
export const applyContactImportMapping = ({
  rows,
  sourceText,
  mapping,
  normalizedLabel,
  targetField,
}: ApplyContactImportMappingOptions): ParsedImportRow[] => {
  const parsedByRowIndex = new Map(
    parseContactImportText(sourceText, { mapping }).map((row) => [
      row.rowIndex,
      row,
    ]),
  );
  const merged = rows.map((row) => {
    const parsed = parsedByRowIndex.get(row.rowIndex);
    if (!parsed) {
      return row;
    }

    const containedLabel = row.blockErrors.some(
      (error) => error.normalizedLabel === normalizedLabel,
    );
    return {
      rowIndex: row.rowIndex,
      fields:
        targetField === "ignore" || !containedLabel
          ? row.fields
          : { ...row.fields, [targetField]: parsed.fields[targetField] },
      blockErrors: parsed.blockErrors,
      rawLines: parsed.rawLines,
    };
  });

  return assignStableImportIds(validateRows(merged), rows);
};

const CUSTOM_FIELD_LABELS: {
  key: CustomFieldKey;
  label: string;
}[] = [
  { key: "rg", label: "RG" },
  { key: "nacionalidade", label: "Nacionalidade" },
  { key: "estadoCivil", label: "Estado civil" },
  { key: "uniaoEstavel", label: "União estável" },
  { key: "profissao", label: "Profissão" },
];

const createImportRowIds = (): ImportRowIds => ({
  contactId: toSafeId<"contact">(crypto.randomUUID()),
  customFieldIds: {
    rg: crypto.randomUUID(),
    nacionalidade: crypto.randomUUID(),
    estadoCivil: crypto.randomUUID(),
    uniaoEstavel: crypto.randomUUID(),
    profissao: crypto.randomUUID(),
  },
});

/** Assign submission identifiers only from event/state transitions, never render. */
export const assignStableImportIds = (
  rows: ParsedImportRow[],
  previousRows: readonly ParsedImportRow[] = [],
): ParsedImportRow[] => {
  const previousIds = new Map(
    previousRows.flatMap((row) =>
      row.importIds ? [[row.rowIndex, row.importIds] as const] : [],
    ),
  );

  return rows.map((row) => {
    if (row.status === "error") {
      return row;
    }
    return {
      ...row,
      importIds:
        row.importIds ?? previousIds.get(row.rowIndex) ?? createImportRowIds(),
    };
  });
};

export const toImportRowVars = (
  row: ParsedImportRow,
): ImportContactRowVars | null => {
  if (row.status === "error") {
    return null;
  }

  const { importIds } = row;
  if (!importIds) {
    return null;
  }

  const { fields } = row;

  const customFields = CUSTOM_FIELD_LABELS.filter(({ key }) => fields[key]).map(
    ({ key, label }) => ({
      id: importIds.customFieldIds[key],
      label,
      value: fields[key],
    }),
  );

  return {
    id: importIds.contactId,
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
