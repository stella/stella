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
    attachmentSelection: "Attachments",
    attachmentReadError:
      "Outlook could not read all attachments. No email was saved. Update Outlook or reopen the add-in, then try again.",
    attachmentsSaved: "{count, number} attachment(s) saved.",
    attachmentsSkipped: "Some attachments were skipped",
    browserMode: "Browser preview",
    checkDraft: "Check draft",
    checked: "Checked",
    chooseMatter: "Choose matter",
    composeMode: "Compose mode",
    copiedToClipboard: "Copied to clipboard.",
    copyOrInsertDraft: "Insert or copy draft",
    dialogOriginUnsupported:
      "Update Outlook to sign in securely, then reopen the add-in.",
    draftIntentPlaceholder:
      "e.g. Acknowledge receipt and say we will review by Friday.",
    draftPlacementError: "Could not insert or copy the draft",
    draftReply: "Draft reply",
    externalRecipients: "External recipients",
    handoffDescription: "Sign in to continue using stella in Outlook.",
    handoffMissingDialog: "Open this page from the stella Outlook task pane.",
    handoffSignInCta: "Sign in to stella",
    handoffSuccess: "Signed in. You can close this window.",
    handoffTitle: "Sign in to stella",
    insertedIntoDraft: "Inserted into draft.",
    inlineAttachmentSkipped: "Inline attachment skipped",
    inlineAttachmentSkippedDescription:
      "{count, number} inline attachment(s) will not be saved as matter files.",
    loadError: "Could not load the Outlook item.",
    loading: "Loading email",
    matterLoadError: "Could not load matters",
    matterSearch: "Search matters",
    noAttachments: "No ordinary attachments detected.",
    noBody: "No body text available.",
    noIssuesDescription:
      "No obvious pre-send issues were detected by V1 checks.",
    noIssuesFound: "No issues found",
    noMatterSelected: "No matter selected",
    noMatterSelectedDescription:
      "Choose and confirm the matter before saving this email.",
    noMatterResults: "No matters matched.",
    openStella: "Open stella",
    openSavedEmail: "Open saved email",
    openedReplyDraft: "Opened a reply draft.",
    possibleMissingAttachment: "Possible missing attachment",
    possibleMissingAttachmentDescription:
      "The email mentions an attachment, but Outlook reports none.",
    previousEmailSaveCompleted:
      "The previous email save finished. Review this email and save it separately.",
    readMode: "Read mode",
    refresh: "Refresh",
    saveButtonLabel: "Save to matter: {matterName}",
    saveEmail: "Save to matter",
    saveErrorFallback: "Could not save email",
    saveFailed: "Save failed",
    saveSuccess: "Saved to matter",
    saved: "Saved",
    saving: "Saving...",
    signInFailed: "Sign-in failed",
    signInHint: "Sign in to stella in the browser, then return to Outlook.",
    stellaForOutlook: "stella for Outlook",
    subjectFallback: "(No subject)",
    suggested: "Suggested",
    summarize: "Summarize",
    summarizing: "Summarizing email",
    summary: "Summary",
    dateOrDeadlineLanguage: "Date or deadline language",
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
