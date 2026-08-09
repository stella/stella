export const EMAIL_HEADER_CITATION_ID = {
  bcc: "header-bcc",
  cc: "header-cc",
  date: "header-date",
  from: "header-from",
  subject: "header-subject",
  to: "header-to",
} as const;

export type EmailHeaderCitationId =
  (typeof EMAIL_HEADER_CITATION_ID)[keyof typeof EMAIL_HEADER_CITATION_ID];

const EMAIL_HEADER_CITATION_IDS = new Set<string>(
  Object.values(EMAIL_HEADER_CITATION_ID),
);
const EMAIL_BODY_CITATION_ID_RE = /^body-[0-9]{4}$/u;

export const isEmailCitationBlockId = (value: string): boolean =>
  EMAIL_HEADER_CITATION_IDS.has(value) || EMAIL_BODY_CITATION_ID_RE.test(value);
