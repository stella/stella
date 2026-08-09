export const EMAIL_CITATION_HREF_PREFIX = "#email:";
export const EMAIL_CITATION_SCROLL_EVENT = "email:scroll-to-citation";

const EMAIL_CITATION_HREF_RE =
  /^#email:(?<fieldId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(?<blockId>header-(?:bcc|cc|date|from|subject|to)|body-[0-9]{4})$/iu;

export type EmailCitationBlock = {
  id: string;
  text: string;
};

export type EmailCitationSnapshot = {
  blocks: EmailCitationBlock[];
};

export type EmailCitationTarget = {
  blockId: string;
  fieldId: string;
};

export const parseEmailCitationHref = (
  href: string,
): EmailCitationTarget | null => {
  const match = EMAIL_CITATION_HREF_RE.exec(href);
  const fieldId = match?.groups?.["fieldId"];
  const blockId = match?.groups?.["blockId"];
  return fieldId && blockId ? { blockId, fieldId } : null;
};

declare global {
  // eslint-disable-next-line typescript-eslint/consistent-type-definitions -- interface declaration merging is required to augment lib.dom WindowEventMap
  interface WindowEventMap {
    "email:scroll-to-citation": CustomEvent<EmailCitationTarget>;
  }
}
