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
  return domain && domain.includes(".") ? domain : null;
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

export const buildSummary = (snapshot: MailSnapshot): string => {
  const opening = snapshot.bodyText
    .split(sentenceSplitPattern)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  const questions = extractQuestions(snapshot);
  const dates = extractPotentialDates(snapshot);
  const attachments = snapshot.attachments
    .filter((attachment) => !attachment.isInline)
    .map((attachment) => attachment.name);

  const lines = [
    `Subject: ${snapshot.subject}`,
    snapshot.from ? `From: ${snapshot.from.name || snapshot.from.email}` : null,
    opening ? `Summary: ${opening}` : "Summary: No body text was available.",
    attachments.length > 0
      ? `Attachments: ${attachments.join(", ")}`
      : "Attachments: none detected",
    questions.length > 0 ? `Open questions: ${questions.join(" ")}` : null,
    dates.length > 0 ? `Date signals: ${dates.join(", ")}` : null,
  ];

  return lines.filter((line): line is string => line !== null).join("\n");
};

export const buildReplyDraft = ({
  intent,
  snapshot,
}: {
  intent: string;
  snapshot: MailSnapshot;
}): string => {
  const firstName = snapshot.from?.name.split(/\s+/u).at(0);
  const salutation = firstName ? `Hi ${firstName},` : "Hello,";
  const questions = extractQuestions(snapshot);
  const dates = extractPotentialDates(snapshot);
  const attachmentLine =
    snapshot.attachments.length > 0
      ? `I have reviewed the material you sent (${snapshot.attachments
          .map((attachment) => attachment.name)
          .join(", ")}).`
      : "I have reviewed your note.";
  const trimmedIntent = intent.trim();
  const intentLine =
    trimmedIntent ||
    "I will come back with a more detailed view once I have checked the matter file.";

  return [
    salutation,
    "",
    attachmentLine,
    intentLine,
    questions.length > 0
      ? `I also noted the open question: ${questions.at(0)}`
      : null,
    dates.length > 0
      ? `I have treated ${dates.at(0)} as a date to confirm.`
      : null,
    "",
    "Best,",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
};

export const runDraftChecks = ({
  selectedWorkspaceId,
  snapshot,
}: {
  selectedWorkspaceId: string | null;
  snapshot: MailSnapshot;
}): DraftCheck[] => {
  const checks: DraftCheck[] = [];
  const recipients = [...snapshot.to, ...snapshot.cc];
  const externalRecipients = getExternalRecipients({
    recipients,
    userEmail: snapshot.userEmail,
  });

  if (!selectedWorkspaceId) {
    checks.push({
      description:
        "Choose the matter before saving or relying on matter context.",
      title: "No matter selected",
      type: "warning",
    });
  }

  if (externalRecipients.length > 0) {
    checks.push({
      description: externalRecipients
        .map((recipient) => recipient.email)
        .join(", "),
      title: "External recipients",
      type: "risk",
    });
  }

  if (hasAttachmentMention(snapshot) && snapshot.attachments.length === 0) {
    checks.push({
      description:
        "The email mentions an attachment, but Outlook reports none.",
      title: "Possible missing attachment",
      type: "risk",
    });
  }

  const dates = extractPotentialDates(snapshot);
  if (dates.length > 0) {
    checks.push({
      description: dates.join(", "),
      title: "Date or deadline language",
      type: "info",
    });
  }

  const inlineAttachments = snapshot.attachments.filter(
    (attachment) => attachment.isInline,
  );
  if (inlineAttachments.length > 0) {
    checks.push({
      description: `${inlineAttachments.length} inline attachment(s) will not be saved as matter files.`,
      title: "Inline attachment skipped",
      type: "info",
    });
  }

  if (checks.length === 0) {
    checks.push({
      description: "No obvious pre-send issues were detected by V1 checks.",
      title: "No issues found",
      type: "info",
    });
  }

  return checks;
};
