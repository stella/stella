/** Publisher court types; Slovak city courts exercise district jurisdiction. */
export const SK_COURT_TIERS = {
  "Ústavný súd": { level: "apex", jurisdiction: "constitutional" },
  "Najvyšší súd": { level: "apex", jurisdiction: "general" },
  "Najvyšší súd SR": { level: "apex", jurisdiction: "general" },
  "Najvyšší správny súd": { level: "apex", jurisdiction: "administrative" },
  "Krajský súd": { level: "appellate", jurisdiction: "general" },
  "Okresný súd": { level: "first-instance", jurisdiction: "general" },
  "Mestský súd": { level: "first-instance", jurisdiction: "general" },
  "Správny súd": { level: "first-instance", jurisdiction: "administrative" },
  "Špecializovaný trestný súd": {
    level: "first-instance",
    jurisdiction: "special",
  },
  "Špeciálny súd": { level: "first-instance", jurisdiction: "special" },
} as const;

/** The registry publishes the same typSudu for NS and NSS. */
export const SK_COURT_REGISTRY_TIERS = {
  sud_175: SK_COURT_TIERS["Najvyšší správny súd"],
} as const;
