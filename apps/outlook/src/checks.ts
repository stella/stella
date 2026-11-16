import type { Translate } from "@/components/panel";
import type { DraftCheck, MailAddress, MailSnapshot } from "@/types";

const ATTACHMENT_WORDS = [
  "attach",
  "attached",
  "attachment",
  "enclosed",
  "příloze",
  "priloze",
] as const;

const DATE_WORD_PATTERN =
  /\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/giu;
const NUMERIC_DATE_PATTERN = /\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/gu;

const sentenceSplitPattern = /(?<=[.!?])\s+/u;

const normalizeDomain = (email: string): string | null => {
  const domain = email.split("@").at(1)?.toLowerCase();
  return domain?.includes(".") ? domain : null;
};

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const getExternalRecipients = ({
  recipients,
  userEmail,
}: {
  recipients: MailAddress[];
  userEmail: string | null;
}): MailAddress[] => {
  const userDomain = userEmail ? normalizeDomain(userEmail) : null;
  if (!userDomain) {
    return [];
  }

  return recipients.filter((recipient) => {
    const domain = normalizeDomain(recipient.email);
    return domain !== null && domain !== userDomain;
  });
};

/** Whether the text names an attachment ("attached", "enclosed", "v příloze"). */
const mentionsAttachment = (text: string): boolean => {
  const haystack = text.toLowerCase();
  return ATTACHMENT_WORDS.some((word) => haystack.includes(word));
};

export const hasAttachmentMention = (snapshot: MailSnapshot): boolean =>
  mentionsAttachment(`${snapshot.subject}\n${snapshot.bodyText}`);

export const extractQuestions = (snapshot: MailSnapshot): string[] =>
  snapshot.bodyText
    .split(sentenceSplitPattern)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.endsWith("?"))
    .slice(0, 5);

/** Weekday, month and numeric date words in the text, first eight. */
const extractDates = (text: string): string[] => {
  const matches = [
    ...(text.match(DATE_WORD_PATTERN) ?? []),
    ...(text.match(NUMERIC_DATE_PATTERN) ?? []),
  ];
  return unique(matches.map((match) => match.trim())).slice(0, 8);
};

export const extractPotentialDates = (snapshot: MailSnapshot): string[] =>
  extractDates(snapshot.bodyText);

/**
 * What to look at before sending a drafted reply. The checks read the draft,
 * not the email it answers, and say nothing when nothing needs a look.
 *
 * - Recipients outside the user's domain are flagged only while composing,
 *   where the user chose them; a reply goes back to the person who wrote.
 * - A draft that names an attachment is flagged when the reply will carry
 *   no attached file: a reply from read mode never does, and an inline
 *   image does not count.
 * - Dates in the draft are listed so the user confirms them.
 */
export const runReplyChecks = ({
  draft,
  snapshot,
  t,
}: {
  draft: string;
  snapshot: MailSnapshot;
  t: Translate;
}): DraftCheck[] => {
  const checks: DraftCheck[] = [];

  if (snapshot.mode === "compose") {
    const externalRecipients = getExternalRecipients({
      recipients: [...snapshot.to, ...snapshot.cc, ...snapshot.bcc],
      userEmail: snapshot.userEmail,
    });
    if (externalRecipients.length > 0) {
      checks.push({
        description: externalRecipients
          .map((recipient) => recipient.email)
          .join(", "),
        title: t("externalRecipients"),
        type: "warning",
      });
    }
  }

  // An inline image is part of the body, not the file the draft names.
  const replyHasAttachments =
    snapshot.mode === "compose" &&
    snapshot.attachments.some((attachment) => !attachment.isInline);
  if (mentionsAttachment(draft) && !replyHasAttachments) {
    checks.push({
      description: t("draftMentionsAttachmentDescription"),
      title: t("draftMentionsAttachment"),
      type: "warning",
    });
  }

  const dates = extractDates(draft);
  if (dates.length > 0) {
    checks.push({
      description: dates.join(", "),
      title: t("draftDates"),
      type: "info",
    });
  }

  return checks;
};
