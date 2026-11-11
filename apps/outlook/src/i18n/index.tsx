import type { PropsWithChildren } from "react";

import { IntlProvider } from "use-intl";
import { createTranslator } from "use-intl/core";

import { getOfficeDisplayLanguage } from "@/lib/office";

const DEFAULT_OUTLOOK_LOCALE = "en";
const SUPPORTED_OUTLOOK_LOCALES = [DEFAULT_OUTLOOK_LOCALE] as const;
type OutlookLocale = (typeof SUPPORTED_OUTLOOK_LOCALES)[number];

export const resolveOutlookLocale = (
  candidates: readonly string[],
): OutlookLocale => {
  for (const candidate of candidates) {
    const language = candidate.toLowerCase().split(/[-_]/u).at(0);
    if (language === DEFAULT_OUTLOOK_LOCALE) {
      return language;
    }
  }
  return DEFAULT_OUTLOOK_LOCALE;
};

const outlookLocale = (): OutlookLocale => {
  const officeLanguage = getOfficeDisplayLanguage();
  const browserLanguages =
    typeof navigator === "undefined" ? [] : navigator.languages;
  return resolveOutlookLocale([
    ...(officeLanguage ? [officeLanguage] : []),
    ...browserLanguages,
  ]);
};

const messages = {
  outlook: {
    aiDataNotice:
      "Questions and drafts send this email's text, and passages from the matter's documents, to your organization's AI provider. Check every answer before you rely on it.",
    aiDataNoticeLabel: "How answers are made",
    aiErrorFallback: "stella could not answer. Try again in a moment.",
    aiUnavailable: "AI is unavailable right now",
    ask: "Ask",
    askLabel: "Ask about this email",
    askPlaceholder: "Ask about this email, or say what the reply should say",
    assistTitle: "Ask stella",
    attachmentCount:
      "{count, plural, one {# attachment} other {# attachments}}",
    attachmentReadError:
      "Outlook could not read all attachments. No email was saved. Update Outlook or reopen the add-in, then try again.",
    attachmentsSkipped: "Not included",
    cancel: "Cancel",
    changeMatter: "Change",
    checked: "Before you send",
    chooseMatter: "Matter",
    chooseMatterHint: "Pick the matter this email belongs to.",
    clearSearch: "Clear search",
    copied: "Copied",
    copiedToClipboard: "Copied to clipboard.",
    copy: "Copy",
    dialogOriginUnsupported:
      "Update Outlook to sign in securely, then reopen the add-in.",
    draftDates: "Dates in the draft",
    draftDefaultIntent: "Write a reply that answers everything the email asks.",
    draftLabel: "Draft",
    draftMentionsAttachment: "The draft mentions an attachment",
    draftMentionsAttachmentDescription:
      "Attach it to the reply before you send.",
    draftPlacementError: "Could not insert or copy the draft",
    draftReply: "Draft reply",
    emailTooLarge: "This email is too large to save to stella.",
    externalRecipients: "External recipients",
    fileEmail: "File email",
    filedDescription: "Filed with its attachments",
    finishSaving: "Finish saving",
    groundedIn: "Answers draw on documents in <matter>{matterName}</matter>",
    groundedInEmailOnly:
      "Answers draw on this email only. Pick a matter to include its documents.",
    insertIntoDraft: "Insert into draft",
    insertIntoReply: "Insert into reply",
    insertedIntoDraft: "Inserted into draft.",
    itemChanged: "The selected email changed. Review it and save again.",
    loadError: "Could not load the Outlook item.",
    loading: "Loading email",
    matterLoadError: "Could not load matters",
    matterSearch: "Search matters",
    moreActions: "More actions",
    noFileColumn:
      "This matter has no file column. Add one in stella, then try again.",
    noMatterResults: "No matters matched.",
    openSavedEmail: "Open in stella",
    openSource: "Open {title} in stella",
    openStella: "Open stella",
    openedReplyDraft: "Opened a reply draft.",
    refresh: "Refresh",
    saveErrorFallback: "Could not save email",
    saveFailed: "Save failed",
    saveNotFinalized:
      "The email was uploaded but stella has not confirmed it yet. Try again to finish saving.",
    saveSuccess: "Saved to matter",
    savedRebuilt:
      "Outlook could not provide the original message, so it was rebuilt from its fields; inline images are not included.",
    signInCancelled:
      "The sign-in window was closed before signing in finished.",
    signInCta: "Sign in",
    signInDenied:
      "Access was not granted. Sign in again and allow access to continue.",
    signInFailedDescription:
      "stella could not complete sign-in. Try again in a moment.",
    signInHeadline: "Clarity for every case.",
    signInSubtitle:
      "Documents, case law, and review under control. Powered by AI.",
    signInTerms:
      "By continuing, you agree to our <terms>Terms of Service</terms>.",
    signOut: "Sign out",
    sources: "Sources",
    subjectFallback: "(No subject)",
    suggested: "Suggested",
    summarize: "Summarize",
    working: "Working on it",
  },
} as const;

export const translator = createTranslator({
  locale: DEFAULT_OUTLOOK_LOCALE,
  messages,
  namespace: "outlook",
});

export const OutlookIntlProvider = ({ children }: PropsWithChildren) => (
  <IntlProvider locale={outlookLocale()} messages={messages}>
    {children}
  </IntlProvider>
);
