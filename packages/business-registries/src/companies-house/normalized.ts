import {
  availableField,
  notLoadedField,
  toValidatedRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryEntity,
  NormalizedRegistryKeyPerson,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { EntityStatus } from "../shared/status.js";
import type {
  CompaniesHouseAddress,
  CompaniesHouseCompany,
  CompaniesHouseEntityStatus,
  CompaniesHouseOfficer,
  CompaniesHouseSearchResult,
} from "./types.js";
import { validateCompanyNumber } from "./validation.js";

type NormalizeStatusOptions = {
  removedAt: string | null;
};

const normalizeStatus = (
  status: CompaniesHouseEntityStatus,
  { removedAt }: NormalizeStatusOptions,
): EntityStatus => {
  switch (status.type) {
    case "active":
    case "open":
    case "registered":
      return { type: "active" };
    case "dissolved":
      return { type: "dissolved" };
    case "liquidation":
      return { type: "liquidating" };
    case "insolvency-proceedings":
      return { type: "bankruptcy" };
    case "removed":
      return { type: "deleted", at: removedAt };
    case "administration":
    case "closed":
    case "converted-closed":
    case "receivership":
    case "voluntary-arrangement":
      return { type: "inactive" };
    case "unknown":
      return { type: "unknown" };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

const normalizeAddress = (
  address: CompaniesHouseAddress,
): NormalizedRegistryAddress => ({
  streetName: address.addressLine1,
  houseNumber: address.premises,
  orientationNumber: null,
  orientationLetter: null,
  municipalityPart: address.addressLine2,
  municipality: address.locality,
  postalCode: address.postalCode,
  county: address.region,
  stateName: address.country,
  textAddress: address.textAddress,
});

const normalizeOfficer = (
  officer: CompaniesHouseOfficer,
): NormalizedRegistryKeyPerson => ({
  name: officer.name,
  nameWithTitles: null,
  position: officer.role.title ?? officer.role.code,
  organName: null,
  // `appointedBefore` is only an upper bound for historical records, not an
  // exact appointment date. The normalized `since` field carries exact dates.
  since: officer.appointedOn,
  address: officer.address?.textAddress ?? null,
  citizenship: officer.nationality,
  birthDate: officer.dateOfBirth
    ? {
        value: `${officer.dateOfBirth.year}-${String(officer.dateOfBirth.month).padStart(2, "0")}`,
        precision: "month",
      }
    : null,
  identifier: officer.identification?.registrationNumber ?? null,
  share: null,
  link: null,
});

export type NormalizeCompaniesHouseOptions = {
  /** Officers returned by the separate Companies House officers endpoint. */
  officers?: CompaniesHouseOfficer[];
};

export const toNormalizedEntity = (
  company: CompaniesHouseCompany,
  options?: NormalizeCompaniesHouseOptions,
): NormalizedRegistryEntity => ({
  country: "GB",
  registryId: toValidatedRegistryIdentifier({
    scheme: "GB-CRN",
    value: company.companyNumber,
    validate: validateCompanyNumber,
  }),
  identifiers: [],
  name: company.name,
  nameWithoutLegalForm: unsupportedField(),
  legalForm: availableField(
    company.type ? { code: company.type, label: null } : null,
  ),
  status: availableField(
    normalizeStatus(company.status, { removedAt: company.dateOfCessation }),
  ),
  statusDetail: company.statusDetail ?? company.status.type,
  address: availableField(
    company.registeredOfficeAddress
      ? normalizeAddress(company.registeredOfficeAddress)
      : null,
  ),
  creationDate: availableField(company.dateOfCreation),
  registrationDate: unsupportedField(),
  removalDate: availableField(company.dateOfCessation),
  registryRecord: unsupportedField(),
  keyPeople: options?.officers
    ? availableField([
        { name: null, people: options.officers.map(normalizeOfficer) },
      ])
    : notLoadedField(),
  shareCapital: unsupportedField(),
  shareCapitalPaid: unsupportedField(),
  actingClause: unsupportedField(),
  registryUrl: availableField(company.registryUrl),
  warnings: unsupportedField(),
});

export const toNormalizedSearchResult = (
  result: CompaniesHouseSearchResult,
): NormalizedRegistrySearchResult => ({
  country: "GB",
  registryId: toValidatedRegistryIdentifier({
    scheme: "GB-CRN",
    value: result.companyNumber,
    validate: validateCompanyNumber,
  }),
  name: result.name,
  legalForm: availableField(
    result.type ? { code: result.type, label: null } : null,
  ),
  status: availableField(
    normalizeStatus(result.status, { removedAt: result.dateOfCessation }),
  ),
  address: availableField(result.address),
  registryUrl: availableField(result.registryUrl),
});
