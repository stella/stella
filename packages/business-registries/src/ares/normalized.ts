import {
  availableField,
  fromValidatedRegistryIdentifier,
  notLoadedField,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryEntity,
  NormalizedRegistryKeyPeopleGroup,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { AresAddress, AresCompany, AresSearchResult } from "./types.js";

const normalizeAddress = (address: AresAddress): NormalizedRegistryAddress => ({
  streetName: address.street,
  houseNumber: address.houseNumber,
  orientationNumber: address.orientationNumber,
  orientationLetter: address.orientationLetter,
  municipalityPart: address.municipalityPart,
  municipality: address.municipality,
  postalCode: address.postalCode,
  county: address.district,
  stateName: address.country,
  textAddress: address.textAddress,
});

const normalizeKeyPeople = (
  company: AresCompany,
): NormalizedRegistryKeyPeopleGroup[] =>
  company.statutoryBodies.map((body) => ({
    name: body.organName,
    people: body.members.map((member) => ({
      name: member.name,
      nameWithTitles: null,
      position: member.role,
      organName: body.organName,
      since: member.since,
      address: member.address,
      citizenship: null,
      birthDate: null,
      identifier: null,
      share: null,
      link: null,
    })),
  }));

export type NormalizeAresOptions = {
  /** Whether the separate commercial-register enrichment was loaded. */
  vrLoaded: boolean;
};

export const toNormalizedEntity = (
  company: AresCompany,
  options: NormalizeAresOptions,
): NormalizedRegistryEntity => ({
  country: "CZ",
  registryId: fromValidatedRegistryIdentifier("CZ-ICO", company.ico),
  identifiers: [],
  name: company.name,
  nameWithoutLegalForm: unsupportedField(),
  legalForm: availableField(
    company.legalForm ? { code: company.legalForm, label: null } : null,
  ),
  status: unsupportedField(),
  statusDetail: company.status,
  address: availableField(
    company.address ? normalizeAddress(company.address) : null,
  ),
  creationDate: availableField(company.dateEstablished),
  registrationDate: availableField(company.dateRegistered),
  removalDate: unsupportedField(),
  registryRecord: options.vrLoaded
    ? availableField(
        company.courtFile
          ? {
              courtName: company.courtFile.court,
              section: company.courtFile.section,
              idNumber: company.courtFile.insert,
              reference: [
                company.courtFile.section,
                company.courtFile.insert,
                company.courtFile.court,
              ].join(" "),
            }
          : null,
      )
    : notLoadedField(),
  keyPeople: options.vrLoaded
    ? availableField(normalizeKeyPeople(company))
    : notLoadedField(),
  shareCapital: options.vrLoaded
    ? availableField(
        company.shareCapital
          ? { text: company.shareCapital, amount: null, currency: null }
          : null,
      )
    : notLoadedField(),
  shareCapitalPaid: unsupportedField(),
  actingClause: options.vrLoaded
    ? availableField(company.actingClause)
    : notLoadedField(),
  registryUrl: availableField(company.registryUrl),
  warnings: unsupportedField(),
});

export const toNormalizedSearchResult = (
  result: AresSearchResult,
): NormalizedRegistrySearchResult => ({
  country: "CZ",
  registryId: fromValidatedRegistryIdentifier("CZ-ICO", result.ico),
  name: result.name,
  legalForm: unsupportedField(),
  status: unsupportedField(),
  address: availableField(result.address),
  registryUrl: unsupportedField(),
});
