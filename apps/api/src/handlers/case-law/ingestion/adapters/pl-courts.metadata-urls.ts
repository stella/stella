export const PL_COURTS_METADATA_URL_SCHEMA = {
  href: "url",
  division: {
    href: "url",
    court: { href: "url" },
    chamber: { object: { href: "url" }, preserve: "opaque" },
  },
  chambers: { items: { href: "url" } },
  source: { judgmentUrl: "url" },
} as const;
