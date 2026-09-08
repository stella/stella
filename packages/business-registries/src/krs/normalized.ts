import { panic, Result } from "better-result";
import { Temporal } from "temporal-polyfill/full";

import {
  availableField,
  toValidatedRegistryIdentifier,
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
import { validateKrsNumber, validateNip, validateRegon } from "./validation.js";

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
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
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

const POLISH_DATE = /^(?<day>\d{2})\.(?<month>\d{2})\.(?<year>\d{4})$/u;

const normalizePolishDate = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  const groups = POLISH_DATE.exec(value)?.groups;
  const daySource = groups?.["day"];
  const monthSource = groups?.["month"];
  const yearSource = groups?.["year"];
  if (!daySource || !monthSource || !yearSource) {
    return null;
  }
  return Result.try(() =>
    Temporal.PlainDate.from(
      {
        day: Number(daySource),
        month: Number(monthSource),
        year: Number(yearSource),
      },
      { overflow: "reject" },
    ).toString(),
  ).unwrapOr(null);
};

export const toNormalizedEntity = (
  entity: KrsEntity,
): NormalizedRegistryEntity => {
  const identifiers: NormalizedRegistryIdentifier[] = [];
  if (entity.identifiers.nip) {
    identifiers.push(
      toValidatedRegistryIdentifier({
        scheme: "PL-NIP",
        value: entity.identifiers.nip,
        validate: validateNip,
      }),
    );
  }
  if (entity.identifiers.regon) {
    identifiers.push(
      toValidatedRegistryIdentifier({
        scheme: "PL-REGON",
        value: entity.identifiers.regon,
        validate: validateRegon,
      }),
    );
  }
  return {
    country: "PL",
    registryId: toValidatedRegistryIdentifier({
      scheme: "PL-KRS",
      value: entity.krsNumber,
      validate: validateKrsNumber,
    }),
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
    registrationDate: availableField(normalizePolishDate(entity.registeredAt)),
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
  registryId: toValidatedRegistryIdentifier({
    scheme: "PL-KRS",
    value: entity.krsNumber,
    validate: validateKrsNumber,
  }),
  name: entity.name,
  legalForm: availableField(
    entity.legalForm ? { code: null, label: entity.legalForm } : null,
  ),
  status: availableField(normalizeStatus(entity.status)),
  address: availableField(entity.address?.textAddress ?? null),
  registryUrl: availableField(entity.registryUrl),
});
