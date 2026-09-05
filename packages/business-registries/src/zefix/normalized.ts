import { panic } from "better-result";

import {
  availableField,
  fromCanonicalRegistryIdentifier,
  unsupportedField,
} from "../shared/normalized.js";
import type {
  NormalizedRegistryEntity,
  NormalizedRegistrySearchResult,
} from "../shared/normalized.js";
import type { EntityStatus } from "../shared/status.js";
import type {
  ZefixCompany,
  ZefixCompanyStatus,
  ZefixSearchResult,
} from "./types.js";

const normalizeStatus = (status: ZefixCompanyStatus): EntityStatus => {
  switch (status.type) {
    case "active":
      return status;
    case "deleted":
      return { type: "deleted", at: status.deletedAt };
    case "unknown":
      return { type: "unknown" };
    default: {
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
    }
  }
};

export const toNormalizedEntity = (
  company: ZefixCompany,
): NormalizedRegistryEntity => ({
  country: "CH",
  registryId: fromCanonicalRegistryIdentifier("CH-UID", company.uid),
  identifiers: [],
  name: company.name,
  nameWithoutLegalForm: unsupportedField(),
  legalForm: availableField(
    company.legalFormId === null
      ? null
      : { code: String(company.legalFormId), label: null },
  ),
  status: availableField(normalizeStatus(company.status)),
  statusDetail:
    company.status.type === "unknown"
      ? company.status.upstreamValue
      : company.status.type,
  address: availableField(
    company.legalSeat
      ? {
          streetName: null,
          houseNumber: null,
          orientationNumber: null,
          orientationLetter: null,
          municipalityPart: null,
          municipality: company.legalSeat,
          postalCode: null,
          county: null,
          stateName: null,
          textAddress: company.legalSeat,
        }
      : null,
  ),
  creationDate: unsupportedField(),
  registrationDate: unsupportedField(),
  removalDate: availableField(
    company.status.type === "deleted" ? company.status.deletedAt : null,
  ),
  registryRecord: unsupportedField(),
  keyPeople: unsupportedField(),
  shareCapital: unsupportedField(),
  shareCapitalPaid: unsupportedField(),
  actingClause: unsupportedField(),
  registryUrl: availableField(company.registryUrl),
  warnings: unsupportedField(),
});

export const toNormalizedSearchResult = (
  result: ZefixSearchResult,
): NormalizedRegistrySearchResult => ({
  country: "CH",
  registryId: fromCanonicalRegistryIdentifier("CH-UID", result.uid),
  name: result.name,
  legalForm: unsupportedField(),
  status: availableField(normalizeStatus(result.status)),
  address: availableField(result.legalSeat),
  registryUrl: availableField(result.registryUrl),
});
