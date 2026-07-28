import {
  availableField,
  toValidatedRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryEntity,
  NormalizedRegistryKeyPeopleGroup,
  NormalizedRegistryKeyPerson,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { OrsrAddress, OrsrCompany, OrsrSearchResult } from "./types.js";
import { validateIco } from "./validation.js";

const normalizeAddress = (address: OrsrAddress): NormalizedRegistryAddress => ({
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

const normalizeKeyPeople = (
  company: OrsrCompany,
): NormalizedRegistryKeyPeopleGroup[] => {
  const groups: NormalizedRegistryKeyPeopleGroup[] =
    company.statutoryBodies.map((body) => ({
      name: body.organName,
      people: body.members.map((member) => ({
        name: member.name,
        nameWithTitles: null,
        position: member.position,
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
  const stakeholderGroups = new Map<string, NormalizedRegistryKeyPerson[]>();
  for (const stakeholder of company.stakeholders) {
    const people = stakeholderGroups.get(stakeholder.organName) ?? [];
    people.push({
      name: stakeholder.name,
      nameWithTitles: null,
      position: stakeholder.position,
      organName: stakeholder.organName,
      since: null,
      address: stakeholder.address,
      citizenship: null,
      birthDate: null,
      identifier: stakeholder.identifier,
      share: stakeholder.share,
      link: null,
    });
    stakeholderGroups.set(stakeholder.organName, people);
  }
  for (const [name, people] of stakeholderGroups) {
    groups.push({ name, people });
  }
  return groups;
};

export const toNormalizedEntity = (
  company: OrsrCompany,
): NormalizedRegistryEntity => ({
  country: "SK",
  registryId: toValidatedRegistryIdentifier({
    scheme: "SK-ICO",
    value: company.ico,
    validate: validateIco,
  }),
  identifiers: [],
  name: company.name,
  nameWithoutLegalForm: unsupportedField(),
  legalForm: availableField(
    company.legalForm ? { code: null, label: company.legalForm } : null,
  ),
  status: availableField(
    company.status.type === "terminated"
      ? { type: "dissolved" }
      : company.status,
  ),
  statusDetail: company.status.type,
  address: availableField(
    company.address ? normalizeAddress(company.address) : null,
  ),
  creationDate: availableField(company.establishedAt),
  registrationDate: unsupportedField(),
  removalDate: availableField(company.terminatedAt),
  registryRecord: availableField(
    company.courtFile
      ? {
          courtName: company.courtFile.court,
          section: company.courtFile.section,
          idNumber: company.courtFile.insertNumber,
          reference: [
            company.courtFile.section,
            company.courtFile.insertNumber,
            company.courtFile.court,
          ].join(" "),
        }
      : null,
  ),
  keyPeople: availableField(normalizeKeyPeople(company)),
  shareCapital: availableField(
    company.shareCapital
      ? { text: company.shareCapital, amount: null, currency: null }
      : null,
  ),
  shareCapitalPaid: availableField(
    company.shareCapitalPaid
      ? { text: company.shareCapitalPaid, amount: null, currency: null }
      : null,
  ),
  actingClause: availableField(company.actingClause),
  registryUrl: availableField(company.registryUrl),
  warnings: unsupportedField(),
});

export const toNormalizedSearchResult = (
  result: OrsrSearchResult,
): NormalizedRegistrySearchResult => ({
  country: "SK",
  registryId: toValidatedRegistryIdentifier({
    scheme: "SK-ICO",
    value: result.ico,
    validate: validateIco,
  }),
  name: result.name,
  legalForm: unsupportedField(),
  status: unsupportedField(),
  address: availableField(result.address),
  registryUrl: unsupportedField(),
});
