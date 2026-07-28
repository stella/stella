import {
  availableField,
  fromValidatedRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryAddress,
  NormalizedRegistryEntity,
  NormalizedRegistryIdentifier,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { EntityStatus } from "../shared/status.js";
import type { KrsAddress, KrsEntity, KrsEntityStatus } from "./types.js";

const normalizeStatus = (status: KrsEntityStatus): EntityStatus => {
  switch (status.type) {
    case "active":
    case "bankruptcy":
    case "dissolved":
    case "liquidating":
    case "unknown":
      return status;
    case "restructuring":
      return { type: "inactive" };
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
};

const normalizeAddress = (address: KrsAddress): NormalizedRegistryAddress => ({
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

export const toNormalizedEntity = (
  entity: KrsEntity,
): NormalizedRegistryEntity => {
  const identifiers: NormalizedRegistryIdentifier[] = [];
  if (entity.identifiers.nip) {
    identifiers.push(
      fromValidatedRegistryIdentifier("PL-NIP", entity.identifiers.nip),
    );
  }
  if (entity.identifiers.regon) {
    identifiers.push(
      fromValidatedRegistryIdentifier("PL-REGON", entity.identifiers.regon),
    );
  }
  return {
    country: "PL",
    registryId: fromValidatedRegistryIdentifier("PL-KRS", entity.krsNumber),
    identifiers,
    name: entity.name,
    nameWithoutLegalForm: unsupportedField(),
    legalForm: availableField(
      entity.legalForm ? { code: null, label: entity.legalForm } : null,
    ),
    status: availableField(normalizeStatus(entity.status)),
    statusDetail: entity.status.type,
    address: availableField(
      entity.address ? normalizeAddress(entity.address) : null,
    ),
    creationDate: unsupportedField(),
    registrationDate: availableField(entity.registeredAt),
    removalDate: unsupportedField(),
    registryRecord: availableField({
      courtName: null,
      section: entity.register,
      idNumber: entity.krsNumber,
      reference: `${entity.register} ${entity.krsNumber}`,
    }),
    keyPeople: unsupportedField(),
    shareCapital: availableField(
      entity.shareCapital
        ? {
            text: `${entity.shareCapital.amount} ${entity.shareCapital.currency}`,
            amount: entity.shareCapital.amount,
            currency: entity.shareCapital.currency,
          }
        : null,
    ),
    shareCapitalPaid: unsupportedField(),
    actingClause: unsupportedField(),
    registryUrl: availableField(entity.registryUrl),
    warnings: unsupportedField(),
  };
};

export const toNormalizedSearchResult = (
  entity: KrsEntity,
): NormalizedRegistrySearchResult => ({
  country: "PL",
  registryId: fromValidatedRegistryIdentifier("PL-KRS", entity.krsNumber),
  name: entity.name,
  legalForm: availableField(
    entity.legalForm ? { code: null, label: entity.legalForm } : null,
  ),
  status: availableField(normalizeStatus(entity.status)),
  address: availableField(entity.address?.textAddress ?? null),
  registryUrl: availableField(entity.registryUrl),
});
