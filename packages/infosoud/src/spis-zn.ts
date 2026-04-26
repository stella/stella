import { NS_CASE_TYPES } from "./constants.js";
import {
  classifyCourtCode,
  isCourtCode,
  resolveCourtCodeAlias,
} from "./courts.js";
import { InfoSoudParseError } from "./errors.js";
import type { SpisZn } from "./types.js";

const SPIS_ZN_SEPARATOR_PATTERN = String.raw`(?:[/_]\s*|\s+)`;

const SPIS_ZN_PATTERN = new RegExp(
  String.raw`^(?<cisloSenatu>\d+)\s*(?<druhVeci>[A-Za-z]+)\s*(?<bcVec>\d+)\s*${SPIS_ZN_SEPARATOR_PATTERN}(?<rocnik>\d{4})(?:\s+(?<courtCode>[A-Z][A-Z0-9]{1,9}))?$`,
  "u",
);

const SPIS_ZN_WITH_TAIL_PATTERN = new RegExp(
  String.raw`^(?<spis>\d+\s*[A-Za-z]+\s*\d+\s*${SPIS_ZN_SEPARATOR_PATTERN}\d{4})(?:\s+(?<tail>.+))?$`,
  "u",
);

export const parseSpisZn = (value: string): SpisZn => {
  const match = SPIS_ZN_PATTERN.exec(value.trim());
  if (!match?.groups) {
    throw new InfoSoudParseError(
      `Cannot parse spisová značka: ${JSON.stringify(value)}`,
    );
  }

  const druhVeciGroup = match.groups["druhVeci"];
  if (!druhVeciGroup) {
    throw new InfoSoudParseError("Missing druhVeci in spisová značka");
  }

  const druhVeci = druhVeciGroup.toUpperCase();
  const explicitCourtCode = match.groups["courtCode"]?.toUpperCase();
  if (explicitCourtCode && !isCourtCode(explicitCourtCode)) {
    throw new InfoSoudParseError(
      `Invalid embedded court code in spisová značka: ${JSON.stringify(explicitCourtCode)}`,
    );
  }

  const courtCode =
    explicitCourtCode ?? (NS_CASE_TYPES.has(druhVeci) ? "NS" : undefined);

  return {
    bcVec: Number(match.groups["bcVec"]),
    cisloSenatu: Number(match.groups["cisloSenatu"]),
    courtCode,
    druhVeci,
    rocnik: Number(match.groups["rocnik"]),
  };
};

export const splitSpisZnAndCourtQuery = (
  value: string,
): { courtQuery?: string | undefined; spisZn: string } => {
  const match = SPIS_ZN_WITH_TAIL_PATTERN.exec(value.trim());
  if (!match?.groups) {
    return { spisZn: value.trim() };
  }

  const spisZn = match.groups["spis"];
  if (!spisZn) {
    return { spisZn: value.trim() };
  }

  return {
    courtQuery: match.groups["tail"]?.trim(),
    spisZn: spisZn.trim(),
  };
};

export const formatSpisZnCanonical = ({
  bcVec,
  cisloSenatu,
  druhVeci,
  rocnik,
}: SpisZn): string => `${cisloSenatu} ${druhVeci} ${bcVec}/${rocnik}`;

export const formatSpisZnCompact = ({
  bcVec,
  cisloSenatu,
  druhVeci,
  rocnik,
}: SpisZn): string => `${cisloSenatu}${druhVeci}${bcVec}_${rocnik}`;

export const toInfoSoudRequestBody = (
  spisZn: SpisZn,
  courtCode?: string,
): Record<string, string> => {
  const resolvedCourtCode = courtCode ?? spisZn.courtCode;
  const requestBody: Record<string, string> = {
    bcVec: String(spisZn.bcVec),
    cisloSenatu: String(spisZn.cisloSenatu),
    druhVeci: spisZn.druhVeci,
    rocnik: String(spisZn.rocnik),
  };

  if (!resolvedCourtCode) {
    return requestBody;
  }

  const normalizedCode = resolveCourtCodeAlias(resolvedCourtCode);
  const courtType = classifyCourtCode(normalizedCode);

  if (courtType === "NS") {
    requestBody["typOrganizace"] = "NEJVYSSI";
    return requestBody;
  }

  if (courtType === "KS" || courtType === "MS" || courtType === "VS") {
    requestBody["druhOrganizace"] = normalizedCode;
    return requestBody;
  }

  requestBody["okresniSoud"] = normalizedCode;
  return requestBody;
};
