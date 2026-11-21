/** Publisher court types; Slovak city courts exercise district jurisdiction. */
export const SK_COURT_TIERS = {
  "Ústavný súd": {
    shortCode: "ÚS",
    level: "apex",
    jurisdiction: "constitutional",
  },
  "Najvyšší súd": { shortCode: "NS", level: "apex", jurisdiction: "general" },
  "Najvyšší súd SR": {
    shortCode: "NS",
    level: "apex",
    jurisdiction: "general",
  },
  "Najvyšší správny súd": {
    shortCode: "NSS",
    level: "apex",
    jurisdiction: "administrative",
  },
  "Krajský súd": {
    shortCode: "KS",
    level: "appellate",
    jurisdiction: "general",
  },
  "Okresný súd": {
    shortCode: "OS",
    level: "first-instance",
    jurisdiction: "general",
  },
  "Mestský súd": {
    shortCode: "MS",
    level: "first-instance",
    jurisdiction: "general",
  },
  "Správny súd": {
    shortCode: "SpS",
    level: "first-instance",
    jurisdiction: "administrative",
  },
  "Špecializovaný trestný súd": {
    shortCode: "ŠTS",
    level: "first-instance",
    jurisdiction: "special",
  },
  "Špeciálny súd": {
    shortCode: "SpS",
    level: "first-instance",
    jurisdiction: "special",
  },
} as const satisfies Readonly<
  Record<string, { shortCode: string; level: string; jurisdiction: string }>
>;

/** The registry publishes the same typSudu for NS and NSS. */
export const SK_COURT_REGISTRY_TIERS = {
  sud_175: SK_COURT_TIERS["Najvyšší správny súd"],
} as const;
