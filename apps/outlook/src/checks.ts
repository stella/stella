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

export const hasAttachmentMention = (snapshot: MailSnapshot): boolean => {
  const haystack = `${snapshot.subject}\n${snapshot.bodyText}`.toLowerCase();
  return ATTACHMENT_WORDS.some((word) => haystack.includes(word));
};

export const extractQuestions = (snapshot: MailSnapshot): string[] =>
  snapshot.bodyText
    .split(sentenceSplitPattern)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.endsWith("?"))
    .slice(0, 5);

export const extractPotentialDates = (snapshot: MailSnapshot): string[] => {
  const matches = [
    ...(snapshot.bodyText.match(DATE_WORD_PATTERN) ?? []),
    ...(snapshot.bodyText.match(NUMERIC_DATE_PATTERN) ?? []),
  ];
  return unique(matches.map((match) => match.trim())).slice(0, 8);
};

export const runDraftChecks = ({
  selectedWorkspaceId,
  snapshot,
  t,
}: {
  selectedWorkspaceId: string | null;
  snapshot: MailSnapshot;
  t: Translate;
}): DraftCheck[] => {
  const checks: DraftCheck[] = [];
  const recipients = [...snapshot.to, ...snapshot.cc, ...snapshot.bcc];
  const externalRecipients = getExternalRecipients({
    recipients,
    userEmail: snapshot.userEmail,
  });

  if (!selectedWorkspaceId) {
    checks.push({
      description: t("noMatterSelectedDescription"),
      title: t("noMatterSelected"),
      type: "warning",
    });
  }

  if (externalRecipients.length > 0) {
    checks.push({
      description: externalRecipients
        .map((recipient) => recipient.email)
        .join(", "),
      title: t("externalRecipients"),
      type: "risk",
    });
  }

  if (hasAttachmentMention(snapshot) && snapshot.attachments.length === 0) {
    checks.push({
      description: t("possibleMissingAttachmentDescription"),
      title: t("possibleMissingAttachment"),
      type: "risk",
    });
  }

  const dates = extractPotentialDates(snapshot);
  if (dates.length > 0) {
    checks.push({
      description: dates.join(", "),
      title: t("dateOrDeadlineLanguage"),
      type: "info",
    });
  }

  const inlineAttachments = snapshot.attachments.filter(
    (attachment) => attachment.isInline,
  );
  if (inlineAttachments.length > 0) {
    checks.push({
      description: t("inlineAttachmentSkippedDescription", {
        count: inlineAttachments.length,
      }),
      title: t("inlineAttachmentSkipped"),
      type: "info",
    });
  }

  if (checks.length === 0) {
    checks.push({
      description: t("noIssuesDescription"),
      title: t("noIssuesFound"),
      type: "info",
    });
  }

  return checks;
};
