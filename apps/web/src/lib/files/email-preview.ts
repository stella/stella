export const EMAIL_BODY_FOLD_KIND = {
  quotedHistory: "quoted-history",
  signature: "signature",
} as const;

export type EmailBodyFoldKind =
  (typeof EMAIL_BODY_FOLD_KIND)[keyof typeof EMAIL_BODY_FOLD_KIND];

export type EmailBodyFold = {
  id: string;
  kind: EmailBodyFoldKind;
};
