/** Side-effect-free Better Auth user extensions consumed by the auth runtime. */
export const AUTH_USER_ADDITIONAL_FIELDS = {
  timezoneId: {
    type: "string",
    required: false,
    defaultValue: "UTC",
  },
  preferredName: {
    type: "string",
    required: false,
  },
  wordEditShortcut: {
    type: "string",
    required: false,
  },
  userShortcuts: {
    type: "string",
    required: false,
  },
  guideProgress: {
    type: "string",
    required: false,
    input: false,
  },
  detectedCountry: {
    type: "string",
    required: false,
    input: false,
  },
} as const;
