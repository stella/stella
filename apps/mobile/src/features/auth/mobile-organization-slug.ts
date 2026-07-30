export const mobileOrganizationSlug = (
  name: string,
  uniqueSuffix: string,
): string => {
  const stem = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40)
    .replace(/-$/u, "");
  return `${stem || "organization"}-${uniqueSuffix}`;
};
