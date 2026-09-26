import {
  availableField,
  toValidatedRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryCapital,
  NormalizedRegistryEntity,
  NormalizedRegistryKeyPeopleGroup,
  NormalizedRegistryKeyPerson,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { EntityStatus } from "../shared/status.js";
import { entityUrl } from "./parse.js";
import type {
  RpoAddress,
  RpoEntity,
  RpoMoney,
  RpoPerson,
  RpoSearchResult,
  RpoStatus,
} from "./types.js";
import { isIcoShape } from "./validation.js";

// Same projection as the Slovak commercial register adapter, so both Slovak
// sources report an ended entity alike.
const toEntityStatus = (status: RpoStatus): EntityStatus =>
  status.type === "terminated" ? { type: "dissolved" } : { type: "active" };

const normalizeAddress = (address: RpoAddress): NormalizedRegistryAddress => ({
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

const SLOVAK_MONETARY_FORMATTER = new Intl.NumberFormat("sk-SK", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const normalizeCapital = (money: RpoMoney): NormalizedRegistryCapital => {
  const amount = SLOVAK_MONETARY_FORMATTER.format(money.amount);
  return {
    text: money.currency ? `${amount} ${money.currency}` : amount,
    amount: String(money.amount),
    currency: money.currency,
  };
};

const normalizePerson = (person: RpoPerson): NormalizedRegistryKeyPerson => ({
  name: person.name,
  nameWithTitles: null,
  position: person.position ?? person.organName,
  organName: person.organName,
  since: person.validFrom,
  address: person.address,
  citizenship: null,
  birthDate: null,
  identifier: person.identifier,
  share: null,
  link: null,
});

// Group people in office by body, keeping the register's order of bodies.
const normalizeKeyPeople = (
  entity: RpoEntity,
): NormalizedRegistryKeyPeopleGroup[] => {
  const groups = new Map<string | null, NormalizedRegistryKeyPerson[]>();
  for (const person of [...entity.statutoryBodies, ...entity.stakeholders]) {
    if (person.validTo !== null) {
      continue;
    }
    const people = groups.get(person.organName) ?? [];
    people.push(normalizePerson(person));
    groups.set(person.organName, people);
  }
  return Array.from(groups, ([name, people]) => ({ name, people }));
};

export const toNormalizedEntity = (
  entity: RpoEntity,
): NormalizedRegistryEntity => {
  const actingClauses = entity.authorizations
    .filter((authorization) => authorization.validTo === null)
    .map((authorization) => authorization.value);
  return {
    country: "SK",
    registryId: toValidatedRegistryIdentifier({
      scheme: "SK-ICO",
      value: entity.ico,
      validate: isIcoShape,
    }),
    identifiers: [],
    name: entity.name,
    nameWithoutLegalForm: unsupportedField(),
    legalForm: availableField(entity.legalForm),
    status: availableField(toEntityStatus(entity.status)),
    statusDetail:
      entity.legalStatuses.length > 0
        ? entity.legalStatuses.join("; ")
        : entity.status.type,
    address: availableField(
      entity.address ? normalizeAddress(entity.address) : null,
    ),
    creationDate: availableField(entity.establishedAt),
    registrationDate: unsupportedField(),
    removalDate: availableField(entity.terminatedAt),
    registryRecord: availableField(
      entity.sourceRegister
        ? {
            courtName: entity.sourceRegister.registrationOffice,
            section: null,
            idNumber: entity.sourceRegister.registrationNumber,
            reference: entity.sourceRegister.registrationNumber,
          }
        : null,
    ),
    keyPeople: availableField(normalizeKeyPeople(entity)),
    shareCapital: availableField(
      entity.shareCapital ? normalizeCapital(entity.shareCapital) : null,
    ),
    shareCapitalPaid: availableField(
      entity.shareCapitalPaid
        ? normalizeCapital(entity.shareCapitalPaid)
        : null,
    ),
    actingClause: availableField(
      actingClauses.length > 0 ? actingClauses.join("\n") : null,
    ),
    registryUrl: availableField(entity.registryUrl),
    warnings: unsupportedField(),
  };
};

export const toNormalizedSearchResult = (
  result: RpoSearchResult,
): NormalizedRegistrySearchResult => ({
  country: "SK",
  registryId: toValidatedRegistryIdentifier({
    scheme: "SK-ICO",
    value: result.ico,
    validate: isIcoShape,
  }),
  name: result.name,
  legalForm: unsupportedField(),
  status: availableField(toEntityStatus(result.status)),
  address: availableField(result.address),
  registryUrl: availableField(entityUrl(result.rpoId)),
});
