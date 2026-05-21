const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export type CaseLawDecisionSearchHit = {
  caseNumber: string;
  decisionId: string;
  ecli: string | null;
};

export const isCaseLawDecisionId = (value: string): boolean =>
  UUID_REGEX.test(value.trim());

export const slugifyCaseLawCaseNumber = (caseNumber: string): string =>
  caseNumber
    .toLowerCase()
    .replace(/\//gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "");

export const createCaseLawDecisionRouteParam = ({
  caseNumber,
  decisionId,
}: {
  caseNumber: string;
  decisionId: string;
}): string => `${slugifyCaseLawCaseNumber(caseNumber)}--${decisionId}`;

export const decodeCaseLawDecisionRef = (value: string): string => {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
};

const normalizeDecisionRef = (value: string): string =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export const pickCaseLawDecisionHit = (
  decisionRef: string,
  hits: readonly CaseLawDecisionSearchHit[],
): CaseLawDecisionSearchHit | null => {
  const normalizedRef = normalizeDecisionRef(decisionRef);
  const exactCaseNumber = hits.find(
    (hit) => normalizeDecisionRef(hit.caseNumber) === normalizedRef,
  );

  if (exactCaseNumber) {
    return exactCaseNumber;
  }

  const exactEcli = hits.find(
    (hit) =>
      hit.ecli !== null && normalizeDecisionRef(hit.ecli) === normalizedRef,
  );

  return exactEcli ?? hits.at(0) ?? null;
};
