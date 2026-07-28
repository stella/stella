import {
  availableField,
  toValidatedRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryEntity,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { SudregAddress, SudregCompany } from "./types.js";
import { validateMbs } from "./validation.js";

const normalizeAddress = (
  address: SudregAddress,
): NormalizedRegistryAddress => ({
  streetName: address.street,
  houseNumber: address.houseNumber,
  orientationNumber: address.orientationNumber,
  orientationLetter: address.orientationLetter,
  municipalityPart: address.municipalityPart,
  municipality: address.municipality,
  postalCode: null,
  county: null,
  stateName: null,
  textAddress: address.textAddress,
});

export const toNormalizedEntity = (
  company: SudregCompany,
): NormalizedRegistryEntity => ({
  country: "HR",
  registryId: toValidatedRegistryIdentifier({
    scheme: "HR-MBS",
    value: company.mbs,
    validate: validateMbs,
  }),
  identifiers: [],
  name: company.name,
  nameWithoutLegalForm: unsupportedField(),
  legalForm: availableField(
    company.legalForm ? { code: null, label: company.legalForm } : null,
  ),
  status: unsupportedField(),
  statusDetail: null,
  address: availableField(
    company.address ? normalizeAddress(company.address) : null,
  ),
  creationDate: unsupportedField(),
  registrationDate: unsupportedField(),
  removalDate: unsupportedField(),
  registryRecord: unsupportedField(),
  keyPeople: unsupportedField(),
  shareCapital: availableField(
    company.shareCapital
      ? { text: company.shareCapital, amount: null, currency: null }
      : null,
  ),
  shareCapitalPaid: unsupportedField(),
  actingClause: unsupportedField(),
  registryUrl: availableField(company.registryUrl),
  warnings: availableField(
    company.warnings.map((warning) => ({ code: warning.type })),
  ),
});

export const toNormalizedSearchResult = (
  company: SudregCompany,
): NormalizedRegistrySearchResult => ({
  country: "HR",
  registryId: toValidatedRegistryIdentifier({
    scheme: "HR-MBS",
    value: company.mbs,
    validate: validateMbs,
  }),
  name: company.name,
  legalForm: availableField(
    company.legalForm ? { code: null, label: company.legalForm } : null,
  ),
  status: unsupportedField(),
  address: availableField(company.address?.textAddress ?? null),
  registryUrl: availableField(company.registryUrl),
});
