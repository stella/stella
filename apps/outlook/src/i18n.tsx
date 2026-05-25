import type { PropsWithChildren } from "react";

import { IntlProvider } from "use-intl";

const messages = {
  outlook: {
    attachmentSelection: "Attachments",
    attachmentsSaved: "{count} attachment(s) saved.",
    attachmentsSkipped: "Some attachments were skipped",
    bodyPreview: "Body preview",
    browserMode: "Browser preview",
    checkDraft: "Check draft",
    checked: "Checked",
    chooseMatter: "Choose matter",
    composeMode: "Compose mode",
    copyOrInsertDraft: "Insert or copy draft",
    draftIntent: "Reply intent",
    draftIntentPlaceholder:
      "e.g. Acknowledge receipt and say we will review by Friday.",
    draftReply: "Draft reply",
    importAttachments: "Save selected attachments",
    copiedToClipboard: "Copied to clipboard.",
    insertedIntoDraft: "Inserted into draft.",
    loadError: "Could not load the Outlook item.",
    loading: "Loading email",
    matterLoadError: "Could not load matters",
    matterSearch: "Search matters",
    noAttachments: "No ordinary attachments detected.",
    noBody: "No body text available.",
    noMatterResults: "No matters matched.",
    openStella: "Open Stella",
    openedReplyDraft: "Opened a reply draft.",
    readMode: "Read mode",
    refresh: "Refresh",
    saveButtonLabel: "Save to matter: {matterName}",
    saveEmail: "Save to matter",
    saveErrorFallback: "Could not save email",
    saveFailed: "Save failed",
    saveSuccess: "Saved to matter",
    saving: "Saving...",
    signInHint: "Sign in to Stella in the browser, then return to Outlook.",
    stellaForOutlook: "Stella for Outlook",
    subjectFallback: "(No subject)",
    suggested: "Suggested",
    summarize: "Summarize",
    summary: "Summary",
  },
} as const;

const getLocale = () => {
  const locale = navigator.language || "en";
  return locale.startsWith("en") ? locale : "en";
};

export const I18nProvider = ({ children }: PropsWithChildren) => (
  <IntlProvider
    locale={getLocale()}
    messages={messages}
    timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
  >
    {children}
  </IntlProvider>
);
