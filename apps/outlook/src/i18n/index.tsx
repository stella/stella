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
      "AI actions send this email text to your organization's configured AI provider. Review every output before use.",
    aiUnavailable: "AI is unavailable right now",
    attachmentReadError:
      "Outlook could not read all attachments. No email was saved. Update Outlook or reopen the add-in, then try again.",
    attachmentsSkipped: "Not included",
    browserMode: "Browser preview",
    checked: "Checked",
    chooseMatter: "Choose matter",
    composeMode: "Compose mode",
    copiedToClipboard: "Copied to clipboard.",
    copyOrInsertDraft: "Insert or copy draft",
    dateOrDeadlineLanguage: "Date or deadline language",
    dialogOriginUnsupported:
      "Update Outlook to sign in securely, then reopen the add-in.",
    draftIntentPlaceholder:
      "e.g. Acknowledge receipt and say we will review by Friday.",
    draftPlacementError: "Could not insert or copy the draft",
    draftReply: "Draft reply",
    emailTooLarge: "This email is too large to save to stella.",
    externalRecipients: "External recipients",
    finishSaving: "Finish saving",
    insertedIntoDraft: "Inserted into draft.",
    itemChanged: "The selected email changed. Review it and save again.",
    loadError: "Could not load the Outlook item.",
    loading: "Loading email",
    matterLoadError: "Could not load matters",
    matterSearch: "Search matters",
    noBody: "No body text available.",
    noFileColumn:
      "This matter has no file column. Add one in stella, then try again.",
    noIssuesDescription: "No obvious pre-send issues were detected.",
    noIssuesFound: "No issues found",
    noMatterResults: "No matters matched.",
    noMatterSelected: "No matter selected",
    noMatterSelectedDescription:
      "Choose and confirm the matter before saving this email.",
    openSavedEmail: "Open in stella",
    openStella: "Open stella",
    openedReplyDraft: "Opened a reply draft.",
    possibleMissingAttachment: "Possible missing attachment",
    possibleMissingAttachmentDescription:
      "The email mentions an attachment, but Outlook reports none.",
    readMode: "Read mode",
    refresh: "Refresh",
    saveButtonLabel: "Save to matter: {matterName}",
    saveDescription:
      "Saves the email with its attachments as one email file. stella also lists it under the matter's correspondence.",
    saveEmail: "Save to matter",
    saveErrorFallback: "Could not save email",
    saveFailed: "Save failed",
    saveNotFinalized:
      "The email was uploaded but stella has not confirmed it yet. Try again to finish saving.",
    saveSuccess: "Saved to matter",
    saved: "Saved",
    savedAsEmailFile: "Saved as {fileName}.",
    savedRebuilt:
      "Outlook could not provide the original message, so it was rebuilt from its fields; inline images are not included.",
    signInCancelled:
      "The sign-in window was closed before signing in finished.",
    signInCta: "Sign in to stella",
    signInDenied:
      "Access was not granted. Sign in again and allow access to continue.",
    signInDescription: "Sign in to continue using stella in Outlook.",
    signInFailed: "Sign-in failed",
    signInFailedDescription:
      "stella could not complete sign-in. Try again in a moment.",
    signInTitle: "Sign in to stella",
    signOut: "Sign out",
    stellaForOutlook: "stella for Outlook",
    subjectFallback: "(No subject)",
    suggested: "Suggested",
    summarize: "Summarize",
    summarizing: "Summarizing email",
    summary: "Summary",
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
