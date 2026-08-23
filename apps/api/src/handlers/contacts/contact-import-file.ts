import { Result } from "better-result";
import * as v from "valibot";

import {
  CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION,
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_IGNORE_DESTINATION,
  CONTACT_IMPORT_ISSUE_CODE,
  CONTACT_IMPORT_LABELED_FIELDS,
  CONTACT_IMPORT_MAX_COLUMNS,
  CONTACT_IMPORT_MAX_ROWS,
  CONTACT_IMPORT_VOCABULARIES,
  parseContactImportMapping,
  type ContactImportField,
  type ContactImportIssueCode,
  type ContactImportLabeledField,
  type ContactImportMapping,
  type ContactImportTargetField,
  type ContactImportTaxIdScheme,
  type ContactType,
} from "@stll/api-contract";

import type {
  ContactAddress,
  ContactCustomField,
  ContactEmail,
  ContactMetadata,
  ContactPhone,
} from "@/api/db/schema-validators";
import { classifyBrazilianTaxId } from "@/api/handlers/contacts/contact-import-receipt";
import { CSV_DELIMITERS, CSV_PARSE_STATUS, parseCSV } from "@/api/lib/csv";
import type { CSVDelimiter } from "@/api/lib/csv";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const CONTACT_IMPORT_SAMPLE_LIMIT = 3;
const CONTACT_IMPORT_SAMPLE_LENGTH_LIMIT = 200;
const CONTACT_IMPORT_HEADER_LENGTH_LIMIT = 256;
const CONTACT_IMPORT_NOTES_LIMIT = 50_000;
const CONTACT_IMPORT_TAG_LENGTH_LIMIT = 256;
const CONTACT_IMPORT_TAGS_LIMIT = 50;
const CONTACT_IMPORT_TAGS_CELL_LIMIT = 13_000;

// Mirror `contactCustomFieldSchema` / `contactMetadataSchema`, so a row this
// module previews as valid also passes the commit handler's body schema. The
// contact-import-file test asserts these against the schemas themselves.
const CONTACT_IMPORT_CUSTOM_FIELD_ID_LIMIT = 64;
const CONTACT_IMPORT_CUSTOM_FIELD_LABEL_LIMIT = 128;
const CONTACT_IMPORT_CUSTOM_FIELD_VALUE_LIMIT = 2000;
const CONTACT_IMPORT_CUSTOM_FIELDS_LIMIT = 50;

/**
 * How the uploaded document was read, as reported back to the mapping UI.
 * `labeled` is not a delimiter: it is the `Label: value` block format, whose
 * distinct labels become the column set.
 */
const CONTACT_IMPORT_LABELED_SOURCE = "labeled" as const;

const CONTACT_IMPORT_DELIMITER_TYPE = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
} as const satisfies Record<CSVDelimiter, string>;

export type ContactImportDelimiter =
  | (typeof CONTACT_IMPORT_DELIMITER_TYPE)[CSVDelimiter]
  | typeof CONTACT_IMPORT_LABELED_SOURCE;

export type ContactImportIssue = {
  code: ContactImportIssueCode;
  field: ContactImportField | null;
  rowNumber: number;
};

export type ContactImportCandidate = {
  type: ContactType;
  displayName: string;
  prefix?: string | undefined;
  firstName?: string | undefined;
  middleName?: string | undefined;
  lastName?: string | undefined;
  suffix?: string | undefined;
  organizationName?: string | undefined;
  notes?: string | undefined;
  emails?: ContactEmail[] | undefined;
  phones?: ContactPhone[] | undefined;
  addresses?: ContactAddress[] | undefined;
  tags?: string[] | undefined;
  registrationNumber?: string | undefined;
  taxId?: string | undefined;
  metadata?: ContactMetadata | undefined;
};

export type ContactImportPreviewRow = {
  contact: ContactImportCandidate;
  issues: ContactImportIssue[];
  rowNumber: number;
};

/** The mapping travels as a JSON string in the multipart body. */
export const parseContactImportMappingText = (
  text: string,
): Result<ContactImportMapping, HandlerError> => {
  const parsed = Result.try((): unknown => JSON.parse(text));
  if (Result.isError(parsed)) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid contact import mapping",
      }),
    );
  }
  const mapping = parseContactImportMapping(parsed.value);
  if (!mapping.success) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid contact import mapping",
      }),
    );
  }
  return Result.ok(mapping.mapping);
};

type ContactImportDocument = {
  source:
    | { kind: "delimited"; delimiter: CSVDelimiter }
    | { kind: typeof CONTACT_IMPORT_LABELED_SOURCE };
  headers: string[];
  rows: string[][];
};

const emailSchema = v.pipe(v.string(), v.email(), v.maxLength(320));

const normalizeToken = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");

const FIELD_ALIASES = {
  type: ["type", "kind", "contacttype", "typ", "druh"],
  display_name: [
    "displayname",
    "fullname",
    "name",
    "nazev",
    "jmeno",
    "meno",
    "nome",
  ],
  prefix: ["prefix", "title", "salutation", "titul"],
  first_name: ["firstname", "givenname", "forename", "jmeno", "meno"],
  middle_name: ["middlename", "secondname"],
  last_name: ["lastname", "surname", "familyname", "prijmeni", "priezvisko"],
  suffix: ["suffix", "namesuffix"],
  organization_name: [
    "organizationname",
    "organisationname",
    "company",
    "companyname",
    "firm",
    "firma",
    "spolecnost",
  ],
  primary_email: [
    "email",
    "emailaddress",
    "primaryemail",
    "mail",
    "emailovaadresa",
  ],
  primary_phone: [
    "phone",
    "phonenumber",
    "telephone",
    "mobile",
    "telefon",
    "mobil",
  ],
  address_line_1: [
    "address",
    "addressline1",
    "street",
    "ulice",
    "adresa",
    "endereco",
  ],
  address_line_2: ["addressline2", "street2"],
  city: ["city", "town", "mesto", "obec"],
  state: ["state", "province", "region", "kraj"],
  postal_code: ["postalcode", "postcode", "zipcode", "zip", "psc"],
  country: ["country", "countryname", "zeme", "stat"],
  notes: ["notes", "note", "comment", "poznamka"],
  tags: ["tags", "labels", "categories", "stitky"],
  registration_number: [
    "registrationnumber",
    "companynumber",
    "businessid",
    "ico",
  ],
  tax_id: ["taxid", "vatid", "vatnumber", "dic", "cpf", "cnpj", "cpfcnpj"],
} as const satisfies Record<ContactImportField, readonly string[]>;

/**
 * What a column header can suggest. `ignore` is absent on purpose: it is the
 * fallback for a header nothing recognizes, never something an alias declares.
 */
export type ContactImportSuggestedTarget =
  | ContactImportField
  | typeof CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION;

/**
 * Where each label of a `Label: value` vocabulary lands. The five identity
 * labels a Brazilian procuração carries (RG, nationality, marital status,
 * civil union, occupation) have no first-class contact field, so they become
 * custom fields under their own label rather than being forced into `notes`.
 */
const LABELED_FIELD_DESTINATION = {
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
  ContactImportSuggestedTarget
>;

const BRAZILIAN_VOCABULARY_ID = "BR:pt-BR";

const BRAZILIAN_TAX_ID_TOKENS = new Set(
  CONTACT_IMPORT_VOCABULARIES[BRAZILIAN_VOCABULARY_ID].fields.tax_id.labels.map(
    normalizeToken,
  ),
);

const TARGET_FOR_ALIAS = new Map<string, ContactImportSuggestedTarget>();
for (const field of CONTACT_IMPORT_FIELDS) {
  for (const alias of FIELD_ALIASES[field]) {
    if (!TARGET_FOR_ALIAS.has(alias)) {
      TARGET_FOR_ALIAS.set(alias, field);
    }
  }
}
// Vocabulary labels are the source of truth for the labeled-text format; the
// loop above already covers the ones that reach a first-class field, so this
// only adds destinations `FIELD_ALIASES` cannot express (custom fields).
for (const vocabulary of Object.values(CONTACT_IMPORT_VOCABULARIES)) {
  for (const labeledField of CONTACT_IMPORT_LABELED_FIELDS) {
    for (const label of vocabulary.fields[labeledField].labels) {
      const token = normalizeToken(label);
      if (!TARGET_FOR_ALIAS.has(token)) {
        TARGET_FOR_ALIAS.set(token, LABELED_FIELD_DESTINATION[labeledField]);
      }
    }
  }
}

/** The destination inspection suggests for a column header, if any. */
export const suggestedTargetForHeader = (
  header: string,
): ContactImportSuggestedTarget | undefined =>
  TARGET_FOR_ALIAS.get(normalizeToken(header));

const delimiterScore = (rows: readonly string[][]): number => {
  const first = rows.at(0);
  if (!first) {
    return 0;
  }
  const width = first.length;
  const consistentRows = rows.filter((row) => row.length === width).length;
  return width * 10_000 + consistentRows;
};

// A `Label: value` line: the label carries no delimiter character, so a real
// CSV/TSV record can never be mistaken for one.
const LABELED_LINE_RE = /^[^:\t,;]{1,64}:/u;
const LABELED_REPEAT_SEPARATOR = "; ";

const splitLines = (text: string): string[] =>
  text.replaceAll("\r\n", "\n").split("\n");

/** Blocks of non-blank lines, separated by one or more blank lines. */
const splitLabeledBlocks = (text: string): string[][] => {
  const blocks: string[][] = [];
  let block: string[] = [];

  for (const rawLine of splitLines(text)) {
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

type LabeledDocumentShape = {
  everyLineIsLabeled: boolean;
  hasBlockSeparator: boolean;
};

const labeledDocumentShape = (text: string): LabeledDocumentShape => {
  const lines = splitLines(text).map((line) => line.trim());
  const nonBlank = lines.filter((line) => line.length > 0);
  return {
    everyLineIsLabeled:
      nonBlank.length > 0 &&
      nonBlank.every((line) => LABELED_LINE_RE.test(line)),
    hasBlockSeparator: splitLabeledBlocks(text).length > 1,
  };
};

const parseLabeledDocument = (text: string): ContactImportDocument => {
  const blocks = splitLabeledBlocks(text).map((lines) =>
    lines.flatMap((line) => {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        return [];
      }
      const label = line.slice(0, colonIndex).trim();
      return [
        {
          label,
          token: normalizeToken(label),
          value: line.slice(colonIndex + 1).trim(),
        },
      ];
    }),
  );

  // Labels that alias the same first-class field (a person block's `CPF`
  // and a company block's `CNPJ`) share one column, keyed by the field, so
  // the mapping step sees a single tax-id column instead of two half-empty
  // ones. Custom-field and unknown labels stay keyed by their own token.
  const columnKey = (token: string): string => {
    const target = TARGET_FOR_ALIAS.get(token);
    return target === undefined ||
      target === CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION
      ? `label:${token}`
      : `field:${target}`;
  };

  const headers: string[] = [];
  const headerIndexes = new Map<string, number>();
  for (const block of blocks) {
    for (const { label, token } of block) {
      const key = columnKey(token);
      if (!headerIndexes.has(key)) {
        headerIndexes.set(key, headers.length);
        headers.push(label);
      }
    }
  }

  // A label repeated inside one block (two `E-mail:` lines) keeps every
  // value, joined so the reviewer sees both; for a single-valued field the
  // validator then reports the combined value instead of a value vanishing.
  const rows = blocks.map((block) => {
    const row = Array.from({ length: headers.length }, () => "");
    for (const { token, value } of block) {
      const index = headerIndexes.get(columnKey(token));
      if (index === undefined) {
        continue;
      }
      const existing = row[index];
      row[index] =
        existing && value
          ? `${existing}${LABELED_REPEAT_SEPARATOR}${value}`
          : existing || value;
    }
    return row;
  });

  return { source: { kind: CONTACT_IMPORT_LABELED_SOURCE }, headers, rows };
};

const boundedDocument = (
  document: ContactImportDocument,
): Result<ContactImportDocument, HandlerError> => {
  if (document.rows.length > CONTACT_IMPORT_MAX_ROWS) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many contacts. Maximum ${CONTACT_IMPORT_MAX_ROWS} per import.`,
      }),
    );
  }
  if (document.headers.length > CONTACT_IMPORT_MAX_COLUMNS) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many columns. Maximum ${CONTACT_IMPORT_MAX_COLUMNS}.`,
      }),
    );
  }
  if (
    document.headers.some(
      (header) => header.length > CONTACT_IMPORT_HEADER_LENGTH_LIMIT,
    )
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `A column name is too long. Maximum ${CONTACT_IMPORT_HEADER_LENGTH_LIMIT} characters.`,
      }),
    );
  }
  return Result.ok(document);
};

export const parseContactImportDocument = (
  text: string,
): Result<ContactImportDocument, HandlerError> => {
  if (text.includes("\0")) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid contact import file" }),
    );
  }

  const normalizedText = text.replace(/^\uFEFF/u, "");
  const candidates: {
    delimiter: CSVDelimiter;
    rows: string[][];
    score: number;
    status:
      | typeof CSV_PARSE_STATUS.SUCCESS
      | typeof CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED;
  }[] = [];
  for (const delimiter of CSV_DELIMITERS) {
    const parsed = parseCSV(normalizedText, {
      delimiter,
      maxRows: CONTACT_IMPORT_MAX_ROWS + 1,
    });
    if (parsed.status === CSV_PARSE_STATUS.INVALID) {
      continue;
    }
    candidates.push({
      delimiter,
      rows: parsed.rows,
      score: delimiterScore(parsed.rows),
      status: parsed.status,
    });
  }

  // A tabular reading only wins when some delimiter yields a real table: at
  // least two columns, held by every record. Otherwise a `Label: value` file
  // (whose lines carry no delimiter) would parse as a one-column CSV.
  const hasTabularReading = candidates.some(({ rows }) => {
    const first = rows.at(0);
    return (
      first !== undefined &&
      first.length > 1 &&
      rows.every((row) => row.length === first.length)
    );
  });
  const { everyLineIsLabeled, hasBlockSeparator } =
    labeledDocumentShape(normalizedText);
  if (everyLineIsLabeled && (hasBlockSeparator || !hasTabularReading)) {
    return boundedDocument(parseLabeledDocument(normalizedText));
  }

  const bestScore = Math.max(...candidates.map(({ score }) => score));
  const bestCandidates = candidates.filter(({ score }) => score === bestScore);
  const selected = bestCandidates.at(0);

  const firstRow = selected?.rows.at(0);
  if (!selected || !firstRow) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid or empty contact import file",
      }),
    );
  }
  if (bestCandidates.length > 1 && firstRow.length > 1) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Ambiguous contact import delimiter",
      }),
    );
  }
  if (selected.status === CSV_PARSE_STATUS.ROW_LIMIT_EXCEEDED) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many contacts. Maximum ${CONTACT_IMPORT_MAX_ROWS} per import.`,
      }),
    );
  }

  return boundedDocument({
    source: { kind: "delimited", delimiter: selected.delimiter },
    headers: firstRow.map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/u, "") : header).trim(),
    ),
    rows: selected.rows.slice(1),
  });
};

export const inspectContactImportDocument = ({
  source,
  headers,
  rows,
}: ContactImportDocument) => {
  const assigned = new Set<ContactImportField>();
  const columns = headers.map((name, sourceIndex) => {
    const suggested = suggestedTargetForHeader(name);
    const targetField = ((): ContactImportTargetField => {
      if (suggested === undefined) {
        return CONTACT_IMPORT_IGNORE_DESTINATION;
      }
      if (suggested === CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION) {
        return suggested;
      }
      return assigned.has(suggested)
        ? CONTACT_IMPORT_IGNORE_DESTINATION
        : suggested;
    })();
    if (
      targetField !== CONTACT_IMPORT_IGNORE_DESTINATION &&
      targetField !== CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION
    ) {
      assigned.add(targetField);
    }

    const samples: string[] = [];
    for (const row of rows) {
      const sample = row.at(sourceIndex)?.trim();
      const samplePreview = sample?.slice(
        0,
        CONTACT_IMPORT_SAMPLE_LENGTH_LIMIT,
      );
      if (samplePreview && !samples.includes(samplePreview)) {
        samples.push(samplePreview);
      }
      if (samples.length === CONTACT_IMPORT_SAMPLE_LIMIT) {
        break;
      }
    }

    return { name, samples, sourceIndex, targetField };
  });

  const hasOrganizationName = columns.some(
    ({ targetField }) => targetField === "organization_name",
  );
  const hasPersonalName = columns.some(
    ({ targetField }) =>
      targetField === "first_name" || targetField === "last_name",
  );
  const hasBrazilianTaxId = headers.some((name) =>
    BRAZILIAN_TAX_ID_TOKENS.has(normalizeToken(name)),
  );

  return {
    columns,
    defaultType:
      hasOrganizationName && !hasPersonalName ? "organization" : "person",
    delimiter: (source.kind === CONTACT_IMPORT_LABELED_SOURCE
      ? CONTACT_IMPORT_LABELED_SOURCE
      : CONTACT_IMPORT_DELIMITER_TYPE[
          source.delimiter
        ]) satisfies ContactImportDelimiter,
    generateDisplayName: !assigned.has("display_name"),
    rowCount: rows.length,
    taxIdScheme: hasBrazilianTaxId ? "br_cpf_cnpj" : "none",
  } as const;
};

const valueOrUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const typeFromValue = (value: string | undefined): ContactType | undefined => {
  const token = normalizeToken(value ?? "");
  if (
    ["person", "individual", "privateperson", "osoba", "fyzickaosoba"].includes(
      token,
    )
  ) {
    return "person";
  }
  if (
    [
      "organization",
      "organisation",
      "company",
      "business",
      "firm",
      "firma",
      "spolecnost",
      "pravnickaosoba",
    ].includes(token)
  ) {
    return "organization";
  }
  return undefined;
};

const tagsFromValue = (
  value: string | undefined,
): { tags: string[] | undefined; invalid: boolean } => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { tags: undefined, invalid: false };
  }

  const parsed = Result.try((): unknown => JSON.parse(trimmed));
  if (!Result.isError(parsed) && Array.isArray(parsed.value)) {
    if (!parsed.value.every((item) => typeof item === "string")) {
      return { tags: undefined, invalid: true };
    }
    const tags = parsed.value.flatMap((item) =>
      item.trim() ? [item.trim()] : [],
    );
    return { tags, invalid: false };
  }

  return {
    tags: trimmed
      .split(/[;|]/u)
      .map((tag) => tag.trim())
      .filter(Boolean),
    invalid: false,
  };
};

const FIELD_MAX_LENGTH = {
  type: 64,
  display_name: 512,
  prefix: 32,
  first_name: 256,
  middle_name: 256,
  last_name: 256,
  suffix: 32,
  organization_name: 512,
  primary_email: 320,
  primary_phone: 32,
  address_line_1: 512,
  address_line_2: 512,
  city: 256,
  state: 256,
  postal_code: 32,
  country: 128,
  notes: CONTACT_IMPORT_NOTES_LIMIT,
  tags: CONTACT_IMPORT_TAGS_CELL_LIMIT,
  registration_number: 64,
  tax_id: 64,
} as const satisfies Record<ContactImportField, number>;

/**
 * The candidate's own string for each field whose bound can be measured on a
 * built contact. `type` and `tags` are absent on purpose: their bound applies
 * to the source cell (a free-text type word, a serialized tag list), which no
 * candidate carries, so `previewContactImport` measures those two itself.
 */
const CANDIDATE_FIELD_VALUE = {
  display_name: ({ displayName }) => displayName,
  prefix: ({ prefix }) => prefix,
  first_name: ({ firstName }) => firstName,
  middle_name: ({ middleName }) => middleName,
  last_name: ({ lastName }) => lastName,
  suffix: ({ suffix }) => suffix,
  organization_name: ({ organizationName }) => organizationName,
  primary_email: ({ emails }) => emails?.at(0)?.address,
  primary_phone: ({ phones }) => phones?.at(0)?.number,
  address_line_1: ({ addresses }) => addresses?.at(0)?.line1,
  address_line_2: ({ addresses }) => addresses?.at(0)?.line2,
  city: ({ addresses }) => addresses?.at(0)?.city,
  state: ({ addresses }) => addresses?.at(0)?.state,
  postal_code: ({ addresses }) => addresses?.at(0)?.postalCode,
  country: ({ addresses }) => addresses?.at(0)?.country,
  notes: ({ notes }) => notes,
  registration_number: ({ registrationNumber }) => registrationNumber,
  tax_id: ({ taxId }) => taxId,
} as const satisfies Record<
  Exclude<ContactImportField, "tags" | "type">,
  (candidate: ContactImportCandidate) => string | undefined
>;

type MeasurableImportField = keyof typeof CANDIDATE_FIELD_VALUE;

const isMeasurableImportField = (
  field: ContactImportField,
): field is MeasurableImportField => field in CANDIDATE_FIELD_VALUE;

const MEASURABLE_IMPORT_FIELDS = CONTACT_IMPORT_FIELDS.filter(
  isMeasurableImportField,
);

/** The fields whose bound only the source cell can carry; see above. */
const SOURCE_CELL_ONLY_FIELDS = CONTACT_IMPORT_FIELDS.filter(
  (field) => !isMeasurableImportField(field),
);

export type ContactImportValidation = {
  contact: ContactImportCandidate;
  issues: ContactImportIssue[];
};

/**
 * Every content-level check a contact must pass before it may be committed,
 * over the built candidate rather than a source row: the same rules apply to
 * a mapped CSV row, an AI-extracted contact, and a row the reviewer edited by
 * hand. Never mutates its input; under `br_cpf_cnpj` the returned contact
 * carries the tax id's bare digits.
 */
export const validateContactImportCandidate = ({
  candidate,
  taxIdScheme,
  rowNumber,
}: {
  candidate: ContactImportCandidate;
  taxIdScheme: ContactImportTaxIdScheme;
  rowNumber: number;
}): ContactImportValidation => {
  const issues: ContactImportIssue[] = [];
  const report = (
    code: ContactImportIssueCode,
    field: ContactImportField | null,
  ) => {
    issues.push({ code, field, rowNumber });
  };

  for (const field of MEASURABLE_IMPORT_FIELDS) {
    const value = CANDIDATE_FIELD_VALUE[field](candidate);
    if (value && value.length > FIELD_MAX_LENGTH[field]) {
      report(CONTACT_IMPORT_ISSUE_CODE.TOO_LONG, field);
    }
  }

  if (!candidate.displayName) {
    report(CONTACT_IMPORT_ISSUE_CODE.DISPLAY_NAME_REQUIRED, "display_name");
  }

  if (candidate.emails?.some(({ address }) => !v.is(emailSchema, address))) {
    report(CONTACT_IMPORT_ISSUE_CODE.INVALID_EMAIL, "primary_email");
  }
  if (
    candidate.phones?.some(
      ({ number }) => number.length > FIELD_MAX_LENGTH.primary_phone,
    )
  ) {
    report(CONTACT_IMPORT_ISSUE_CODE.INVALID_PHONE, "primary_phone");
  }
  if (candidate.addresses?.some(({ line1 }) => !line1.trim())) {
    report(CONTACT_IMPORT_ISSUE_CODE.ADDRESS_LINE_REQUIRED, "address_line_1");
  }

  const { tags } = candidate;
  if (
    tags &&
    (tags.length > CONTACT_IMPORT_TAGS_LIMIT ||
      tags.some((tag) => tag.length > CONTACT_IMPORT_TAG_LENGTH_LIMIT))
  ) {
    report(CONTACT_IMPORT_ISSUE_CODE.TOO_MANY_TAGS, "tags");
  }

  const customFields = candidate.metadata?.customFields;
  if (customFields) {
    if (customFields.length > CONTACT_IMPORT_CUSTOM_FIELDS_LIMIT) {
      report(CONTACT_IMPORT_ISSUE_CODE.TOO_MANY_CUSTOM_FIELDS, null);
    }
    if (
      customFields.some(
        ({ label, value }) =>
          label.length > CONTACT_IMPORT_CUSTOM_FIELD_LABEL_LIMIT ||
          value.length > CONTACT_IMPORT_CUSTOM_FIELD_VALUE_LIMIT,
      )
    ) {
      report(CONTACT_IMPORT_ISSUE_CODE.TOO_LONG, null);
    }
  }

  if (taxIdScheme === "none") {
    return { contact: candidate, issues };
  }
  // Under a checksum scheme the tax id is the row's identity: a row without
  // one cannot be deduplicated or committed, so it is an issue here rather
  // than a surprise skip at commit time.
  if (!candidate.taxId) {
    report(CONTACT_IMPORT_ISSUE_CODE.TAX_ID_REQUIRED, "tax_id");
    return { contact: candidate, issues };
  }
  const classified = classifyBrazilianTaxId(candidate.taxId);
  if (!classified) {
    report(CONTACT_IMPORT_ISSUE_CODE.INVALID_TAX_ID, "tax_id");
    return { contact: candidate, issues };
  }
  if (classified.type !== candidate.type) {
    report(CONTACT_IMPORT_ISSUE_CODE.INVALID_TAX_ID, "tax_id");
  }
  return { contact: { ...candidate, taxId: classified.digits }, issues };
};

type CustomFieldColumn = {
  id: string;
  label: string;
  sourceIndex: number;
};

/**
 * Deterministic per-column id: the same column yields the same custom-field id
 * on every preview, and the source index keeps two columns whose labels
 * normalize alike from colliding inside one contact.
 */
const customFieldId = (label: string, sourceIndex: number): string => {
  const token = normalizeToken(label).slice(
    0,
    CONTACT_IMPORT_CUSTOM_FIELD_ID_LIMIT - 8,
  );
  return `${token || "field"}-${sourceIndex}`;
};

export const previewContactImport = ({
  document,
  mapping,
}: {
  document: ContactImportDocument;
  mapping: ContactImportMapping;
}) => {
  const targetFields = new Set<ContactImportField>();
  const sourceIndexes = new Set<number>();
  const customFieldColumns: CustomFieldColumn[] = [];
  for (const column of mapping.columns) {
    if (column.sourceIndex >= document.headers.length) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Import mapping references a missing column",
        }),
      );
    }
    if (sourceIndexes.has(column.sourceIndex)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Import mapping contains a duplicate source column",
        }),
      );
    }
    sourceIndexes.add(column.sourceIndex);
    if (column.targetField === CONTACT_IMPORT_IGNORE_DESTINATION) {
      continue;
    }
    if (column.targetField === CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION) {
      const label =
        document.headers[column.sourceIndex]?.trim() ||
        `Column ${column.sourceIndex + 1}`;
      if (label.length > CONTACT_IMPORT_CUSTOM_FIELD_LABEL_LIMIT) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: `A custom field label is too long. Maximum ${CONTACT_IMPORT_CUSTOM_FIELD_LABEL_LIMIT} characters.`,
          }),
        );
      }
      customFieldColumns.push({
        id: customFieldId(label, column.sourceIndex),
        label,
        sourceIndex: column.sourceIndex,
      });
      continue;
    }
    if (targetFields.has(column.targetField)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Each stella field can only be mapped once",
        }),
      );
    }
    targetFields.add(column.targetField);
  }
  if (customFieldColumns.length > CONTACT_IMPORT_CUSTOM_FIELDS_LIMIT) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many custom field columns. Maximum ${CONTACT_IMPORT_CUSTOM_FIELDS_LIMIT}.`,
      }),
    );
  }

  // Row numbers point back into the source: a delimited file's first data
  // row sits under the header on line 2, a labeled document's first block is
  // block 1.
  const firstRowNumber =
    document.source.kind === CONTACT_IMPORT_LABELED_SOURCE ? 1 : 2;
  const rows = document.rows.map((row, rowIndex): ContactImportPreviewRow => {
    const rowNumber = rowIndex + firstRowNumber;
    const issues: ContactImportIssue[] = [];
    const values = new Map<ContactImportField, string>();
    if (row.length !== document.headers.length) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.ROW_LENGTH_MISMATCH,
        field: null,
        rowNumber,
      });
    }
    for (const { sourceIndex, targetField } of mapping.columns) {
      if (
        targetField !== CONTACT_IMPORT_IGNORE_DESTINATION &&
        targetField !== CONTACT_IMPORT_CUSTOM_FIELD_DESTINATION
      ) {
        values.set(targetField, row.at(sourceIndex) ?? "");
      }
    }

    // Only the two fields whose bound belongs to the source cell; every other
    // length check runs on the built candidate, in one place.
    for (const field of SOURCE_CELL_ONLY_FIELDS) {
      const value = valueOrUndefined(values.get(field));
      if (value && value.length > FIELD_MAX_LENGTH[field]) {
        issues.push({
          code: CONTACT_IMPORT_ISSUE_CODE.TOO_LONG,
          field,
          rowNumber,
        });
      }
    }

    const taxId = valueOrUndefined(values.get("tax_id"));
    // Classified here only to DERIVE the type of a row with no type column;
    // whether the number itself is acceptable is the validator's call.
    const classifiedTaxId =
      mapping.taxIdScheme === "br_cpf_cnpj" && taxId
        ? classifyBrazilianTaxId(taxId)
        : null;

    const mappedType = valueOrUndefined(values.get("type"));
    const declaredType = mappedType ? typeFromValue(mappedType) : undefined;
    // An unmapped type column takes the tax id's own kind over the batch
    // default; a mapped one that contradicts the tax id is a row-level error,
    // since the commit handler cannot store both readings.
    const type = mappedType
      ? declaredType
      : (classifiedTaxId?.type ?? mapping.defaultType);
    if (!type) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.INVALID_TYPE,
        field: "type",
        rowNumber,
      });
    }

    const prefix = valueOrUndefined(values.get("prefix"));
    const firstName = valueOrUndefined(values.get("first_name"));
    const middleName = valueOrUndefined(values.get("middle_name"));
    const lastName = valueOrUndefined(values.get("last_name"));
    const suffix = valueOrUndefined(values.get("suffix"));
    const organizationName = valueOrUndefined(values.get("organization_name"));
    const mappedDisplayName = valueOrUndefined(values.get("display_name"));
    const generatedDisplayName =
      type === "organization"
        ? organizationName
        : [prefix, firstName, middleName, lastName, suffix]
            .filter(Boolean)
            .join(" ");
    const displayName =
      mappedDisplayName ??
      (mapping.generateDisplayName ? generatedDisplayName : undefined) ??
      "";

    const email = valueOrUndefined(values.get("primary_email"));
    const phone = valueOrUndefined(values.get("primary_phone"));

    const line1 = valueOrUndefined(values.get("address_line_1"));
    const line2 = valueOrUndefined(values.get("address_line_2"));
    const city = valueOrUndefined(values.get("city"));
    const state = valueOrUndefined(values.get("state"));
    const postalCode = valueOrUndefined(values.get("postal_code"));
    const country = valueOrUndefined(values.get("country"));
    const hasAddress = [line1, line2, city, state, postalCode, country].some(
      Boolean,
    );

    const parsedTags = tagsFromValue(values.get("tags"));
    const tags = parsedTags.tags;
    if (parsedTags.invalid) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.INVALID_TAGS,
        field: "tags",
        rowNumber,
      });
    }

    const customFields: ContactCustomField[] = [];
    for (const { id, label, sourceIndex } of customFieldColumns) {
      const value = valueOrUndefined(row.at(sourceIndex));
      if (value) {
        customFields.push({ id, label, value });
      }
    }

    const candidate: ContactImportCandidate = {
      type: type ?? mapping.defaultType,
      displayName,
      prefix,
      firstName,
      middleName,
      lastName,
      suffix,
      organizationName,
      notes: valueOrUndefined(values.get("notes")),
      emails: email
        ? [{ type: "work", address: email, isPrimary: true }]
        : undefined,
      phones: phone
        ? [{ type: "mobile", number: phone, isPrimary: true }]
        : undefined,
      // A row carrying address parts but no street still gets an address, with
      // an empty `line1` the validator rejects: dropping it would hide the
      // fault and lose what the row did say.
      addresses: hasAddress
        ? [
            {
              type: "office",
              line1: line1 ?? "",
              isPrimary: true,
              ...(line2 && { line2 }),
              ...(city && { city }),
              ...(state && { state }),
              ...(postalCode && { postalCode }),
              ...(country && { country }),
            },
          ]
        : undefined,
      tags,
      registrationNumber: valueOrUndefined(values.get("registration_number")),
      taxId,
      metadata: customFields.length > 0 ? { customFields } : undefined,
    };

    const validated = validateContactImportCandidate({
      candidate,
      taxIdScheme: mapping.taxIdScheme,
      rowNumber,
    });

    return {
      contact: validated.contact,
      issues: [...issues, ...validated.issues],
      rowNumber,
    };
  });

  return Result.ok({
    errorCount: rows.reduce((total, row) => total + row.issues.length, 0),
    rows,
    validCount: rows.filter(({ issues }) => issues.length === 0).length,
  });
};
