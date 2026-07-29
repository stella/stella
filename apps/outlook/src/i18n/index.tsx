import type { PropsWithChildren } from "react";

import { IntlProvider } from "use-intl";
import { createTranslator } from "use-intl/core";

const OUTLOOK_LOCALE = "en";
const messages = {
  outlook: {
    aiDataNotice:
      "AI actions send this email text to your organization's configured AI provider. Review every output before use.",
    aiUnavailable: "AI is unavailable right now",
    attachmentSelection: "Attachments",
    attachmentsSaved: "{count} attachment(s) saved.",
    attachmentsSkipped: "Some attachments were skipped",
    browserMode: "Browser preview",
    checkDraft: "Check draft",
    checked: "Checked",
    chooseMatter: "Choose matter",
    composeMode: "Compose mode",
    copiedToClipboard: "Copied to clipboard.",
    copyOrInsertDraft: "Insert or copy draft",
    draftIntentPlaceholder:
      "e.g. Acknowledge receipt and say we will review by Friday.",
    draftReply: "Draft reply",
    handoffDescription: "Sign in to continue using stella in Outlook.",
    handoffMissingDialog: "Open this page from the stella Outlook task pane.",
    handoffSignInCta: "Sign in with Microsoft",
    handoffSuccess: "Signed in. You can close this window.",
    handoffTitle: "Sign in to stella",
    insertedIntoDraft: "Inserted into draft.",
    loadError: "Could not load the Outlook item.",
    loading: "Loading email",
    matterLoadError: "Could not load matters",
    matterSearch: "Search matters",
    noAttachments: "No ordinary attachments detected.",
    noBody: "No body text available.",
    noMatterResults: "No matters matched.",
    openStella: "Open stella",
    openSavedEmail: "Open saved email",
    openedReplyDraft: "Opened a reply draft.",
    readMode: "Read mode",
    refresh: "Refresh",
    saveButtonLabel: "Save to matter: {matterName}",
    saveEmail: "Save to matter",
    saveErrorFallback: "Could not save email",
    saveFailed: "Save failed",
    saveSuccess: "Saved to matter",
    saved: "Saved",
    saving: "Saving...",
    signInHint: "Sign in to stella in the browser, then return to Outlook.",
    stellaForOutlook: "stella for Outlook",
    subjectFallback: "(No subject)",
    suggested: "Suggested",
    summarize: "Summarize",
    summarizing: "Summarizing email",
    summary: "Summary",
  },
} as const;

export const translator = createTranslator({
  locale: OUTLOOK_LOCALE,
  messages,
});

export const OutlookIntlProvider = ({ children }: PropsWithChildren) => (
  <IntlProvider locale={OUTLOOK_LOCALE} messages={messages}>
    {children}
  </IntlProvider>
);
