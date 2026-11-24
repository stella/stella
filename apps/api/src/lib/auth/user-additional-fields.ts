/** Side-effect-free Better Auth user extensions consumed by the auth runtime. */
export const AUTH_USER_ADDITIONAL_FIELDS = {
  timezoneId: {
    type: "string",
    required: false,
    defaultValue: "UTC",
  },
  // No default: an account follows the browser's language until its user
  // picks one.
  locale: {
    type: "string",
    required: false,
  },
  preferredName: {
    type: "string",
    required: false,
  },
  readerAnswerLanguage: { type: "string", required: false },
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
