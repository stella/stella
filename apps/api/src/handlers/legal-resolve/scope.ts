export const LAW_READ_SCOPE = "stella:law_read";
const GENERAL_READ_SCOPE = "stella:read";

export const hasLawReadScope = (scopes: readonly string[]): boolean =>
  scopes.includes(LAW_READ_SCOPE) || scopes.includes(GENERAL_READ_SCOPE);
