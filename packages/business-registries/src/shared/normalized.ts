import type { CountryCode } from "@stll/country-codes";

import { unsafeBrand } from "./canonical-id.js";
import type { CanonicalId, KnownCanonicalIdScheme } from "./canonical-id.js";
import { RegistryValidationError } from "./errors.js";
import type { EntityStatus } from "./status.js";

export type NormalizedRegistryIdentifier<
  Scheme extends KnownCanonicalIdScheme = KnownCanonicalIdScheme,
> = {
  [CurrentScheme in Scheme]: {
    scheme: CurrentScheme;
    value: CanonicalId<CurrentScheme>;
  };
}[Scheme];

type ValidatedRegistryIdentifierOptions<Scheme extends KnownCanonicalIdScheme> =
  {
    scheme: Scheme;
    value: string;
    validate: (value: string) => boolean;
  };

/** Validate the adapter boundary before constructing a canonical identifier. */
export const toValidatedRegistryIdentifier = <
  Scheme extends KnownCanonicalIdScheme,
>({
  scheme,
  value,
  validate,
}: ValidatedRegistryIdentifierOptions<Scheme>): NormalizedRegistryIdentifier<Scheme> => {
  if (!validate(value)) {
    throw new RegistryValidationError(scheme);
  }
  return { scheme, value: unsafeBrand<Scheme>(value) };
};

export const fromCanonicalRegistryIdentifier = <
  Scheme extends KnownCanonicalIdScheme,
>(
  scheme: Scheme,
  value: CanonicalId<Scheme>,
): NormalizedRegistryIdentifier<Scheme> => ({ scheme, value });

export type NormalizedRegistryAddress = {
  streetName: string | null;
  houseNumber: string | null;
  orientationNumber: string | null;
  orientationLetter: string | null;
  municipalityPart: string | null;
  municipality: string | null;
  postalCode: string | null;
  county: string | null;
  stateName: string | null;
  textAddress: string | null;
};

export type NormalizedRegistryRecord = {
  courtName: string | null;
  section: string | null;
  idNumber: string | null;
  reference: string | null;
};

export type NormalizedRegistryBirthDate = {
  value: string;
  precision: "day" | "month" | "year";
};

export type NormalizedRegistryKeyPerson = {
  name: string;
  nameWithTitles: string | null;
  position: string | null;
  organName: string | null;
  since: string | null;
  address: string | null;
  citizenship: string | null;
  birthDate: NormalizedRegistryBirthDate | null;
  identifier: string | null;
  share: string | null;
  link: string | null;
};

export type NormalizedRegistryKeyPeopleGroup = {
  name: string | null;
  people: NormalizedRegistryKeyPerson[];
};

export type NormalizedRegistryCapital = {
  text: string;
  amount: string | null;
  currency: string | null;
};

export type NormalizedRegistryWarning = {
  code: string;
};

export type NormalizedRegistryField<Value> =
  | { availability: "available"; value: Value }
  | { availability: "not-loaded" }
  | { availability: "not-supported" };

export const availableField = <Value>(
  value: Value,
): NormalizedRegistryField<Value> => ({ availability: "available", value });

export const notLoadedField = (): NormalizedRegistryField<never> => ({
  availability: "not-loaded",
});

export const unsupportedField = (): NormalizedRegistryField<never> => ({
  availability: "not-supported",
});

export type NormalizedRegistryEntityFields = {
  actingClause: NormalizedRegistryField<string | null>;
  address: NormalizedRegistryField<NormalizedRegistryAddress | null>;
  creationDate: NormalizedRegistryField<string | null>;
  keyPeople: NormalizedRegistryField<NormalizedRegistryKeyPeopleGroup[]>;
  legalForm: NormalizedRegistryField<{
    code: string | null;
    label: string | null;
  } | null>;
  nameWithoutLegalForm: NormalizedRegistryField<string | null>;
  registrationDate: NormalizedRegistryField<string | null>;
  registryRecord: NormalizedRegistryField<NormalizedRegistryRecord | null>;
  registryUrl: NormalizedRegistryField<string | null>;
  removalDate: NormalizedRegistryField<string | null>;
  shareCapital: NormalizedRegistryField<NormalizedRegistryCapital | null>;
  shareCapitalPaid: NormalizedRegistryField<NormalizedRegistryCapital | null>;
  status: NormalizedRegistryField<EntityStatus>;
  warnings: NormalizedRegistryField<NormalizedRegistryWarning[]>;
};

export type NormalizedRegistryEntity = {
  country: CountryCode;
  registryId: NormalizedRegistryIdentifier;
  identifiers: NormalizedRegistryIdentifier[];
  name: string;
  /** Upstream status text, retained even when no normalized status is available. */
  statusDetail: string | null;
} & NormalizedRegistryEntityFields;

export type NormalizedRegistrySearchFields = {
  address: NormalizedRegistryField<string | null>;
  legalForm: NormalizedRegistryField<{
    code: string | null;
    label: string | null;
  } | null>;
  registryUrl: NormalizedRegistryField<string | null>;
  status: NormalizedRegistryField<EntityStatus>;
};

export type NormalizedRegistrySearchResult = {
  country: CountryCode;
  registryId: NormalizedRegistryIdentifier;
  name: string;
} & NormalizedRegistrySearchFields;
