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

export type EmailCitationHrefTarget = {
  blockId: string;
  entityId: string;
  fieldId: string;
};

export const EMAIL_CITATION_HREF_PREFIX = "#email:";

const EMAIL_HEADER_CITATION_IDS = new Set<string>(
  Object.values(EMAIL_HEADER_CITATION_ID),
);
const EMAIL_BODY_CITATION_ID_RE = /^body-[0-9]{4}$/u;

export const isEmailCitationBlockId = (value: string): boolean =>
  EMAIL_HEADER_CITATION_IDS.has(value) || EMAIL_BODY_CITATION_ID_RE.test(value);

const EMAIL_CITATION_HREF_RE =
  /^#email:(?<entityId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<fieldId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<blockId>[^:]+)$/iu;

export const parseEmailCitationHref = (
  href: string,
): EmailCitationHrefTarget | null => {
  const match = EMAIL_CITATION_HREF_RE.exec(href);
  const entityId = match?.groups?.["entityId"];
  const fieldId = match?.groups?.["fieldId"];
  const blockId = match?.groups?.["blockId"];
  return entityId && fieldId && blockId && isEmailCitationBlockId(blockId)
    ? { blockId, entityId, fieldId }
    : null;
};
