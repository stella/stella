import {
  SOFT_LAW_SERVE_MODE,
  softLawServingSettingOf,
} from "@/api/lib/legal-search/soft-law-serving";

import {
  type RegisteredSoftLawAuthority,
  SOFT_LAW_ADMISSIONS,
} from "./adapters/registry";

const isRegisteredSoftLawAuthority = (
  authority: string,
): authority is RegisteredSoftLawAuthority =>
  Object.entries(SOFT_LAW_ADMISSIONS).some(
    ([key, disposition]) =>
      key === authority && disposition.state === "registered",
  );

/** Sources a schedule may acquire: registered, and with a decision to serve them. */
export const servedRegisteredSoftLawAuthorities = () =>
  Object.keys(SOFT_LAW_ADMISSIONS)
    .filter(isRegisteredSoftLawAuthority)
    .filter(
      (authority) =>
        softLawServingSettingOf(authority).serve !== SOFT_LAW_SERVE_MODE.none,
    );
