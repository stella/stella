import { Result } from "better-result";
import * as v from "valibot";

import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_IGNORE_DESTINATION,
  CONTACT_IMPORT_ISSUE_CODE,
  CONTACT_IMPORT_MAX_COLUMNS,
  parseContactImportMapping,
  type ContactImportField,
  type ContactImportIssueCode,
  type ContactImportMapping,
  type ContactType,
} from "@stll/api-contract";

import type {
  ContactAddress,
  ContactEmail,
  ContactPhone,
} from "@/api/db/schema-validators";
import { CSV_DELIMITERS, CSV_PARSE_STATUS, parseCSV } from "@/api/lib/csv";
import type { CSVDelimiter } from "@/api/lib/csv";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const CONTACT_IMPORT_SAMPLE_LIMIT = 3;
const CONTACT_IMPORT_SAMPLE_LENGTH_LIMIT = 200;
const CONTACT_IMPORT_HEADER_LENGTH_LIMIT = 256;
const CONTACT_IMPORT_NOTES_LIMIT = 50_000;
const CONTACT_IMPORT_TAG_LENGTH_LIMIT = 256;
const CONTACT_IMPORT_TAGS_CELL_LIMIT = 13_000;
const CONTACT_IMPORT_DELIMITER_TYPE = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
} as const satisfies Record<CSVDelimiter, "comma" | "semicolon" | "tab">;

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
};

export type ContactImportPreviewRow = {
  contact: ContactImportCandidate;
  issues: ContactImportIssue[];
  rowNumber: number;
};

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
  delimiter: CSVDelimiter;
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
  display_name: ["displayname", "fullname", "name", "nazev", "jmeno", "meno"],
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
  address_line_1: ["address", "addressline1", "street", "ulice", "adresa"],
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
  tax_id: ["taxid", "vatid", "vatnumber", "dic"],
} as const satisfies Record<ContactImportField, readonly string[]>;

const FIELD_FOR_ALIAS = new Map<string, ContactImportField>();
for (const field of CONTACT_IMPORT_FIELDS) {
  for (const alias of FIELD_ALIASES[field]) {
    if (!FIELD_FOR_ALIAS.has(alias)) {
      FIELD_FOR_ALIAS.set(alias, field);
    }
  }
}

const delimiterScore = (rows: readonly string[][]): number => {
  const first = rows.at(0);
  if (!first) {
    return 0;
  }
  const width = first.length;
  const consistentRows = rows.filter((row) => row.length === width).length;
  return width * 10_000 + consistentRows;
};

export const parseContactImportDocument = (
  text: string,
): Result<ContactImportDocument, HandlerError> => {
  if (text.includes("\0")) {
    return Result.err(
      new HandlerError({ status: 400, message: "Invalid contact import file" }),
    );
  }

  let selected:
    | { delimiter: CSVDelimiter; rows: string[][]; score: number }
    | undefined;
  for (const delimiter of CSV_DELIMITERS) {
    const parsed = parseCSV(text, delimiter);
    if (parsed.status === CSV_PARSE_STATUS.INVALID) {
      continue;
    }
    const candidate = {
      delimiter,
      rows: parsed.rows,
      score: delimiterScore(parsed.rows),
    };
    if (!selected || candidate.score > selected.score) {
      selected = candidate;
    }
  }

  const firstRow = selected?.rows.at(0);
  if (!selected || !firstRow) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Invalid or empty contact import file",
      }),
    );
  }
  if (firstRow.length > CONTACT_IMPORT_MAX_COLUMNS) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many columns. Maximum ${CONTACT_IMPORT_MAX_COLUMNS}.`,
      }),
    );
  }
  if (
    firstRow.some(
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

  const rows = selected.rows.slice(1);
  if (rows.length > LIMITS.contactImportBatchLimit) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: `Too many contacts. Maximum ${LIMITS.contactImportBatchLimit} per import.`,
      }),
    );
  }

  return Result.ok({
    delimiter: selected.delimiter,
    headers: firstRow.map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/u, "") : header).trim(),
    ),
    rows,
  });
};

export const inspectContactImportDocument = ({
  delimiter,
  headers,
  rows,
}: ContactImportDocument) => {
  const assigned = new Set<ContactImportField>();
  const columns = headers.map((name, sourceIndex) => {
    const suggested = FIELD_FOR_ALIAS.get(normalizeToken(name));
    const targetField =
      suggested && !assigned.has(suggested)
        ? suggested
        : CONTACT_IMPORT_IGNORE_DESTINATION;
    if (targetField !== CONTACT_IMPORT_IGNORE_DESTINATION) {
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

  return {
    columns,
    defaultType:
      hasOrganizationName && !hasPersonalName ? "organization" : "person",
    delimiter: CONTACT_IMPORT_DELIMITER_TYPE[delimiter],
    generateDisplayName: !assigned.has("display_name"),
    rowCount: rows.length,
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

export const previewContactImport = ({
  document,
  mapping,
}: {
  document: ContactImportDocument;
  mapping: ContactImportMapping;
}) => {
  const targetFields = new Set<ContactImportField>();
  const sourceIndexes = new Set<number>();
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

  const rows = document.rows.map((row, rowIndex): ContactImportPreviewRow => {
    const rowNumber = rowIndex + 2;
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
      if (targetField !== CONTACT_IMPORT_IGNORE_DESTINATION) {
        values.set(targetField, row.at(sourceIndex) ?? "");
      }
    }

    for (const field of CONTACT_IMPORT_FIELDS) {
      const value = valueOrUndefined(values.get(field));
      if (value && value.length > FIELD_MAX_LENGTH[field]) {
        issues.push({
          code: CONTACT_IMPORT_ISSUE_CODE.TOO_LONG,
          field,
          rowNumber,
        });
      }
    }

    const mappedType = valueOrUndefined(values.get("type"));
    const type = mappedType ? typeFromValue(mappedType) : mapping.defaultType;
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
    if (!displayName) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.DISPLAY_NAME_REQUIRED,
        field: "display_name",
        rowNumber,
      });
    }
    if (
      !mappedDisplayName &&
      displayName.length > FIELD_MAX_LENGTH.display_name
    ) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.TOO_LONG,
        field: "display_name",
        rowNumber,
      });
    }

    const email = valueOrUndefined(values.get("primary_email"));
    if (email && !v.safeParse(emailSchema, email).success) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.INVALID_EMAIL,
        field: "primary_email",
        rowNumber,
      });
    }
    const phone = valueOrUndefined(values.get("primary_phone"));
    if (phone && phone.length > FIELD_MAX_LENGTH.primary_phone) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.INVALID_PHONE,
        field: "primary_phone",
        rowNumber,
      });
    }

    const line1 = valueOrUndefined(values.get("address_line_1"));
    const line2 = valueOrUndefined(values.get("address_line_2"));
    const city = valueOrUndefined(values.get("city"));
    const state = valueOrUndefined(values.get("state"));
    const postalCode = valueOrUndefined(values.get("postal_code"));
    const country = valueOrUndefined(values.get("country"));
    const hasAddress = [line1, line2, city, state, postalCode, country].some(
      Boolean,
    );
    if (hasAddress && !line1) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.ADDRESS_LINE_REQUIRED,
        field: "address_line_1",
        rowNumber,
      });
    }

    const parsedTags = tagsFromValue(values.get("tags"));
    const tags = parsedTags.tags;
    if (parsedTags.invalid) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.INVALID_TAGS,
        field: "tags",
        rowNumber,
      });
    }
    if (
      tags &&
      (tags.length > 50 ||
        tags.some((tag) => tag.length > CONTACT_IMPORT_TAG_LENGTH_LIMIT))
    ) {
      issues.push({
        code: CONTACT_IMPORT_ISSUE_CODE.TOO_MANY_TAGS,
        field: "tags",
        rowNumber,
      });
    }

    const contact: ContactImportCandidate = {
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
      addresses:
        hasAddress && line1
          ? [
              {
                type: "office",
                line1,
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
      taxId: valueOrUndefined(values.get("tax_id")),
    };

    return { contact, issues, rowNumber };
  });

  return Result.ok({
    errorCount: rows.reduce((total, row) => total + row.issues.length, 0),
    rows,
    validCount: rows.filter(({ issues }) => issues.length === 0).length,
  });
};
