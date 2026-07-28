import {
  availableField,
  fromValidatedRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryEntity,
  NormalizedRegistryIdentifier,
  NormalizedRegistryKeyPerson,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { EntityStatus } from "../shared/status.js";
import type {
  RechercheEntreprisesAddress,
  RechercheEntreprisesCompany,
  RechercheEntreprisesDirector,
  RechercheEntreprisesLegalEntityStatus,
  RechercheEntreprisesSearchResult,
} from "./types.js";

const normalizeStatus = (
  status: RechercheEntreprisesLegalEntityStatus,
): EntityStatus => {
  switch (status.type) {
    case "active":
    case "unknown":
      return status;
    case "ceased":
      return { type: "dissolved" };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

const normalizeAddress = (
  address: RechercheEntreprisesAddress,
): NormalizedRegistryAddress => ({
  streetName: address.street,
  houseNumber: null,
  orientationNumber: null,
  orientationLetter: null,
  municipalityPart: null,
  municipality: address.city,
  postalCode: address.postalCode,
  county: null,
  stateName: address.country,
  textAddress: address.textAddress,
});

const normalizeDirector = (
  director: RechercheEntreprisesDirector,
): NormalizedRegistryKeyPerson =>
  director.type === "person"
    ? {
        name: director.fullName,
        nameWithTitles: null,
        position: director.role,
        organName: null,
        since: null,
        address: null,
        citizenship: null,
        birthDate: director.birthYear
          ? { value: director.birthYear, precision: "year" }
          : null,
        identifier: null,
        share: null,
        link: null,
      }
    : {
        name: director.name,
        nameWithTitles: null,
        position: director.role,
        organName: null,
        since: null,
        address: null,
        citizenship: null,
        birthDate: null,
        identifier: director.siren,
        share: null,
        link: null,
      };

export const toNormalizedEntity = (
  company: RechercheEntreprisesCompany,
): NormalizedRegistryEntity => {
  const identifiers: NormalizedRegistryIdentifier[] = [];
  if (company.headOffice) {
    identifiers.push(
      fromValidatedRegistryIdentifier("FR-SIRET", company.headOffice.siret),
    );
  }
  if (
    company.matchedEstablishment &&
    company.matchedEstablishment.siret !== company.headOffice?.siret
  ) {
    identifiers.push(
      fromValidatedRegistryIdentifier(
        "FR-SIRET",
        company.matchedEstablishment.siret,
      ),
    );
  }
  return {
    country: "FR",
    registryId: fromValidatedRegistryIdentifier("FR-SIREN", company.siren),
    identifiers,
    name: company.name,
    nameWithoutLegalForm: unsupportedField(),
    legalForm: availableField(
      company.legalFormCode
        ? { code: company.legalFormCode, label: null }
        : null,
    ),
    status: availableField(normalizeStatus(company.status)),
    statusDetail: company.status.type,
    address: availableField(
      company.headOffice?.address
        ? normalizeAddress(company.headOffice.address)
        : null,
    ),
    creationDate: availableField(company.registeredAt),
    registrationDate: unsupportedField(),
    removalDate: availableField(company.ceasedAt),
    registryRecord: unsupportedField(),
    keyPeople: availableField(
      company.directors.length > 0
        ? [{ name: null, people: company.directors.map(normalizeDirector) }]
        : [],
    ),
    shareCapital: unsupportedField(),
    shareCapitalPaid: unsupportedField(),
    actingClause: unsupportedField(),
    registryUrl: availableField(company.registryUrl),
    warnings: unsupportedField(),
  };
};

export const toNormalizedSearchResult = (
  result: RechercheEntreprisesSearchResult,
): NormalizedRegistrySearchResult => ({
  country: "FR",
  registryId: fromValidatedRegistryIdentifier("FR-SIREN", result.siren),
  name: result.name,
  legalForm: unsupportedField(),
  status: unsupportedField(),
  address: availableField(result.address),
  registryUrl: unsupportedField(),
});
