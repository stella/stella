export type EmailCitationBlock = {
  id: string;
  text: string;
};

export const MAX_EMAIL_CITATION_BLOCKS = 160;
export const MAX_EMAIL_CITATION_BLOCK_TEXT_LENGTH = 500;

export const EMAIL_CITATION_BLOCK_MODE = {
  include: "include",
  omit: "omit",
} as const;

export type EmailCitationBlockMode =
  (typeof EMAIL_CITATION_BLOCK_MODE)[keyof typeof EMAIL_CITATION_BLOCK_MODE];
