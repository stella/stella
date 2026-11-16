import { asc, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { buildPartyIndex } from "@stll/sanctions";
import type {
  BirthDate,
  Identifier,
  PartyIndex,
  ScreenedParty,
} from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { identifierVariants } from "@/api/lib/conflict-check/identifiers";
import { LIMITS } from "@/api/lib/limits";

/**
 * Contacts one check screens. The firm's address book is capped at
 * `LIMITS.contactsCount`, so a check normally reads all of it; a firm over the
 * cap gets a check that says so (`contacts_over_cap`), never a silent subset.
 */
const CONFLICT_CHECK_CONTACT_CAP = LIMITS.contactsCount;

/** Contact ids are UUIDs: code-unit order is a stable, locale-free tie-break. */
export const compareContactIds = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** What the matcher keeps of a contact, beside the index. */
export type ScreenedContact = {
  id: SafeId<"contact">;
  name: string;
  type: "person" | "organization";
};

export type ContactPartyIndex = {
  index: PartyIndex<ScreenedContact>;
  screened: number;
  /** The firm holds more contacts than were screened. */
  overCap: boolean;
};

const dataBoxesSchema = v.nullable(
  v.array(v.looseObject({ id: v.pipe(v.string(), v.minLength(1)) })),
);

const identifier = (
  kind: Identifier["kind"],
  label: string,
  value: string,
): Identifier[] =>
  identifierVariants(value).map((number) => ({
    kind,
    status: "listed",
    label,
    number,
    country: null,
  }));

type ContactRow = {
  id: SafeId<"contact">;
  type: "person" | "organization";
  displayName: string;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  organizationName: string | null;
  dateOfBirthYear: number | null;
  dateOfBirthMonth: number | null;
  dateOfBirthDay: number | null;
  registrationNumber: string | null;
  taxId: string | null;
  vatId: string | null;
  dataBoxes: unknown;
};

const birthDate = (row: ContactRow): BirthDate[] => {
  const {
    dateOfBirthYear: year,
    dateOfBirthMonth: month,
    dateOfBirthDay: day,
  } = row;
  if (year === null) {
    return [];
  }
  if (month === null) {
    return [{ precision: "year", year, circa: false }];
  }
  if (day === null) {
    return [{ precision: "month", year, month, circa: false }];
  }
  return [{ precision: "day", year, month, day, circa: false }];
};

const names = (row: ContactRow): string[] => {
  const personName = [row.firstName, row.middleName, row.lastName]
    .filter((part): part is string => part !== null && part.trim() !== "")
    .join(" ");
  const candidates =
    row.type === "person"
      ? [row.displayName, personName]
      : [row.displayName, row.organizationName ?? ""];
  return [
    ...new Set(candidates.filter((candidate) => candidate.trim() !== "")),
  ];
};

/** One contact as the matcher reads it. */
const screenedContactParty = (
  row: ContactRow,
): ScreenedParty<ScreenedContact> => {
  const dataBoxes = v.safeParse(dataBoxesSchema, row.dataBoxes);
  return {
    ref: { id: row.id, name: row.displayName, type: row.type },
    entityType: row.type === "person" ? "person" : "organisation",
    names: names(row).map((name) => ({ name, quality: "strong" })),
    birthDates: birthDate(row),
    nationalities: [],
    identifiers: [
      ...(row.registrationNumber === null
        ? []
        : identifier("registration", "Company ID", row.registrationNumber)),
      ...(row.taxId === null ? [] : identifier("tax", "Tax ID", row.taxId)),
      ...(row.vatId === null ? [] : identifier("tax", "VAT ID", row.vatId)),
      ...(dataBoxes.success && dataBoxes.output !== null
        ? dataBoxes.output.flatMap((box) =>
            identifier("other", "Data box", box.id),
          )
        : []),
    ],
  };
};

/**
 * Reads the organization's address book through the caller's scoped
 * transaction (contacts are readable organization-wide) and indexes it.
 * `cap` is the contact cap; tests pass a small one.
 */
export const loadContactPartyIndex = async ({
  tx,
  organizationId,
  cap = CONFLICT_CHECK_CONTACT_CAP,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  cap?: number;
}): Promise<ContactPartyIndex> => {
  const rows = await tx
    .select({
      id: contacts.id,
      type: contacts.type,
      displayName: contacts.displayName,
      firstName: contacts.firstName,
      middleName: contacts.middleName,
      lastName: contacts.lastName,
      organizationName: contacts.organizationName,
      dateOfBirthYear: contacts.dateOfBirthYear,
      dateOfBirthMonth: contacts.dateOfBirthMonth,
      dateOfBirthDay: contacts.dateOfBirthDay,
      registrationNumber: contacts.registrationNumber,
      taxId: contacts.taxId,
      vatId: contacts.vatId,
      dataBoxes: sql<unknown>`${contacts.metadata} -> 'dataBoxes'`,
    })
    .from(contacts)
    .where(eq(contacts.organizationId, organizationId))
    .orderBy(asc(contacts.id))
    .limit(cap + 1);
  const screened = rows.slice(0, cap);
  return {
    index: buildPartyIndex(screened.map(screenedContactParty), (left, right) =>
      compareContactIds(left.id, right.id),
    ),
    screened: screened.length,
    overCap: rows.length > cap,
  };
};
