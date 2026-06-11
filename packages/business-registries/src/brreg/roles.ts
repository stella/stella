// Brreg "roles" endpoint — the entity's officer roster (CEO, board
// members, deputy members, auditors, bankruptcy trustees, …) returned
// from `/api/enheter/{orgnr}/roller`.
//
// The upstream response is a list of role groups (`rollegrupper`),
// each grouping together related roles (e.g. the whole board sits in
// one group). The actor in each row is one of three shapes:
//   * person — a natural person (board members, CEO).
//   * enhet  — another registered entity (corporate auditor, public
//              sector parent).
//   * bostyrer — a court-appointed trustee, returned with a single
//              `navn` string and a postal address.
//
// We surface all three, label resigned/de-registered officers
// (`fratraadt` / `avregistrert`) instead of dropping them, and keep
// the role group's `sistEndret` as the change date.

import {
  BrregAPIError,
  BrregRequestError,
  BrregValidationError,
} from "./errors.js";
import { normalizeOrgnr, validateOrgnr } from "./validation.js";

const BASE = "https://data.brreg.no/enhetsregisteret/api";
const TIMEOUT_MS = 10_000;
const MIN_BIRTH_YEAR = 1900;

// ---------------------------------------------------------------------------
// Raw Brreg roles response shapes
// ---------------------------------------------------------------------------

type BrregRawRoleType = {
  kode: string;
  beskrivelse?: string;
};

type BrregRawRolePerson = {
  fodselsdato?: string;
  navn?: {
    fornavn?: string;
    mellomnavn?: string;
    etternavn?: string;
  };
  erDoed?: boolean;
};

type BrregRawRoleEntity = {
  organisasjonsnummer: string;
  navn?: string[];
  organisasjonsform?: BrregRawRoleType;
  erSlettet?: boolean;
};

type BrregRawRoleTrustee = {
  navn: string;
  postadresse?: {
    adresse?: string[];
    postnummer?: string;
    poststed?: string;
    landkode?: string;
  };
  erDoed?: boolean;
};

type BrregRawRole = {
  type: BrregRawRoleType;
  person?: BrregRawRolePerson;
  enhet?: BrregRawRoleEntity;
  bostyrer?: BrregRawRoleTrustee;
  fratraadt?: boolean;
  avregistrert?: boolean;
  rekkefolge?: number;
};

type BrregRawRoleGroup = {
  type: BrregRawRoleType;
  sistEndret?: string;
  roller?: BrregRawRole[];
};

export type BrregRawRolesResponse = {
  rollegrupper?: BrregRawRoleGroup[];
};

// ---------------------------------------------------------------------------
// Domain output
// ---------------------------------------------------------------------------

export type BrregOfficerPerson = {
  name: string;
  /**
   * Birth year only — Brreg returns the full `fodselsdato`, but we
   * trim to the year on the way out so the domain shape never carries
   * the full birth date of a private individual.
   */
  birthYear: number | null;
  isDeceased: boolean;
};

export type BrregOfficerEntity = {
  orgnr: string;
  name: string;
};

export type BrregOfficerTrustee = {
  name: string;
  postalAddress: string | null;
};

export type BrregOfficer = {
  role: { code: string; description: string | null };
  /** Set when the actor is a natural person. */
  person?: BrregOfficerPerson;
  /** Set when the actor is another registered entity. */
  entity?: BrregOfficerEntity;
  /** Set when the actor is a court-appointed trustee (bostyrer). */
  trustee?: BrregOfficerTrustee;
  /**
   * Date the role group was last changed in the register. Useful for
   * dating a resignation in the absence of a per-officer `to` field.
   */
  changedAt: string | null;
  /**
   * `true` when the officer has resigned (`fratraadt`) or been
   * de-registered (`avregistrert`). Brreg returns terminated rows in
   * the same payload — we keep them so callers can show "former CEO"
   * etc. instead of silently dropping records.
   */
  isResigned: boolean;
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const composePersonName = (raw: BrregRawRolePerson): string => {
  const navn = raw.navn;
  if (!navn) {
    return "";
  }
  return [navn.fornavn, navn.mellomnavn, navn.etternavn]
    .filter(Boolean)
    .join(" ");
};

const composeTrusteeAddress = (raw: BrregRawRoleTrustee): string | null => {
  const post = raw.postadresse;
  if (!post) {
    return null;
  }
  const lines = post.adresse?.filter(Boolean) ?? [];
  const composite = [
    lines.length > 0 ? lines.join(", ") : null,
    [post.postnummer, post.poststed].filter(Boolean).join(" ") || null,
    post.landkode ?? null,
  ]
    .filter(Boolean)
    .join(", ");
  return composite.length > 0 ? composite : null;
};

const parseBirthYear = (fodselsdato: string | undefined): number | null => {
  if (!fodselsdato || !/^\d{4}/u.test(fodselsdato)) {
    return null;
  }
  // Brreg returns ISO-style YYYY-MM-DD; take the first four
  // characters. Reject obviously-bogus values — a stray `"95"` would
  // otherwise parse to 95 AD, and a future year is not a valid birth
  // year for a current registry actor.
  const year = Number.parseInt(fodselsdato.slice(0, 4), 10);
  const currentYear = new Date().getUTCFullYear();
  return year >= MIN_BIRTH_YEAR && year <= currentYear ? year : null;
};

export const parseOfficer = (
  raw: BrregRawRole,
  changedAt: string | null,
): BrregOfficer => {
  const isResigned = raw.fratraadt === true || raw.avregistrert === true;
  const officer: BrregOfficer = {
    role: {
      code: raw.type.kode,
      description: raw.type.beskrivelse ?? null,
    },
    changedAt,
    isResigned,
  };
  if (raw.person) {
    officer.person = {
      name: composePersonName(raw.person),
      birthYear: parseBirthYear(raw.person.fodselsdato),
      isDeceased: raw.person.erDoed === true,
    };
  }
  if (raw.enhet) {
    officer.entity = {
      orgnr: raw.enhet.organisasjonsnummer,
      // Brreg returns the entity name as an array (multi-line legal
      // names are rare but possible); join on spaces to keep one string.
      name: (raw.enhet.navn ?? []).filter(Boolean).join(" "),
    };
  }
  if (raw.bostyrer) {
    officer.trustee = {
      name: raw.bostyrer.navn,
      postalAddress: composeTrusteeAddress(raw.bostyrer),
    };
  }
  return officer;
};

export const parseRolesResponse = (
  raw: BrregRawRolesResponse,
): BrregOfficer[] => {
  const officers: BrregOfficer[] = [];
  for (const group of raw.rollegrupper ?? []) {
    const changedAt = group.sistEndret ?? null;
    for (const role of group.roller ?? []) {
      officers.push(parseOfficer(role, changedAt));
    }
  }
  return officers;
};

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRawRoleType = (value: unknown): value is BrregRawRoleType =>
  isRecord(value) && typeof value["kode"] === "string";

const isRawRolePerson = (value: unknown): value is BrregRawRolePerson =>
  isRecord(value) &&
  (value["navn"] === undefined || isRecord(value["navn"])) &&
  (value["erDoed"] === undefined || typeof value["erDoed"] === "boolean");

const isRawRoleEntity = (value: unknown): value is BrregRawRoleEntity =>
  isRecord(value) &&
  typeof value["organisasjonsnummer"] === "string" &&
  (value["navn"] === undefined ||
    (Array.isArray(value["navn"]) &&
      value["navn"].every((item) => typeof item === "string"))) &&
  (value["organisasjonsform"] === undefined ||
    isRawRoleType(value["organisasjonsform"]));

const isRawRoleTrustee = (value: unknown): value is BrregRawRoleTrustee =>
  isRecord(value) &&
  typeof value["navn"] === "string" &&
  (value["postadresse"] === undefined || isRecord(value["postadresse"]));

const isRawRole = (value: unknown): value is BrregRawRole =>
  isRecord(value) &&
  isRawRoleType(value["type"]) &&
  (value["person"] === undefined || isRawRolePerson(value["person"])) &&
  (value["enhet"] === undefined || isRawRoleEntity(value["enhet"])) &&
  (value["bostyrer"] === undefined || isRawRoleTrustee(value["bostyrer"])) &&
  (value["fratraadt"] === undefined ||
    typeof value["fratraadt"] === "boolean") &&
  (value["avregistrert"] === undefined ||
    typeof value["avregistrert"] === "boolean");

const isRawRoleGroup = (value: unknown): value is BrregRawRoleGroup =>
  isRecord(value) &&
  isRawRoleType(value["type"]) &&
  (value["roller"] === undefined ||
    (Array.isArray(value["roller"]) && value["roller"].every(isRawRole)));

const isRawRolesResponse = (value: unknown): value is BrregRawRolesResponse =>
  isRecord(value) &&
  (value["rollegrupper"] === undefined ||
    (Array.isArray(value["rollegrupper"]) &&
      value["rollegrupper"].every(isRawRoleGroup)));

const parseUpstreamMessage = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value["feilmelding"] === "string") {
    return value["feilmelding"];
  }
  return null;
};

const brregGetRoles = async (
  url: string,
): Promise<BrregRawRolesResponse | null> => {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new BrregRequestError(url, "Brreg roles request failed", {
      cause: error,
    });
  }

  if (response.status === 404 || response.status === 410) {
    return null;
  }

  if (!response.ok) {
    let upstreamMessage: string | null = null;
    // Brreg's error envelope is JSON, but upstream proxies
    // (Cloudflare / nginx) can intercept and return HTML error pages
    // — feeding those to `response.json()` throws a SyntaxError that
    // would mask the real status. Guard on Content-Type. The
    // statusText fallback covers HTTP/2 (where it is typically empty).
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        upstreamMessage = parseUpstreamMessage(await response.json());
      } catch {
        // non-JSON body despite the header — ignore
      }
    }
    throw new BrregAPIError({
      message: `Brreg ${response.status}: ${upstreamMessage ?? (response.statusText || "API error")}`,
      httpStatus: response.status,
      upstreamMessage,
    });
  }

  try {
    const body: unknown = await response.json();
    if (!isRawRolesResponse(body)) {
      throw new BrregAPIError({
        message: `Brreg ${response.status}: unexpected roles payload shape`,
        httpStatus: response.status,
        upstreamMessage: null,
      });
    }
    return body;
  } catch (error) {
    if (error instanceof BrregAPIError) {
      throw error;
    }
    throw new BrregAPIError({
      message: `Brreg ${response.status}: invalid JSON payload`,
      httpStatus: response.status,
      upstreamMessage: null,
      cause: error,
    });
  }
};

/**
 * Look up the officer roster for a Norwegian entity by orgnr.
 *
 * Hits `/api/enheter/{orgnr}/roller`. Returns every officer the API
 * surfaces, including resigned / de-registered ones (flagged via
 * `isResigned`) so callers can render "former CEO" etc. rather than
 * silently dropping records.
 *
 * @returns The officer list, or `[]` if the orgnr is unknown.
 * @throws {BrregValidationError} if the orgnr fails MOD-11 validation
 * @throws {BrregAPIError} on Brreg API errors
 * @throws {BrregRequestError} on network failures
 */
export const lookupOfficersByOrgnr = async (
  orgnr: string,
): Promise<BrregOfficer[]> => {
  const normalized = normalizeOrgnr(orgnr);
  if (!validateOrgnr(normalized)) {
    throw new BrregValidationError(`Invalid orgnr: ${orgnr}`);
  }
  const data = await brregGetRoles(`${BASE}/enheter/${normalized}/roller`);
  if (!data) {
    return [];
  }
  return parseRolesResponse(data);
};
