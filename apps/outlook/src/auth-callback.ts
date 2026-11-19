// Where the authorization server returns the dialog. Forwards only the
// authorization response (code or error, state, issuer) to the task pane,
// addressed to this page's own origin, and keeps nothing.

import { buildCallbackMessage } from "@/lib/oauth/authorize";
import { getOfficeRuntime, waitForOffice } from "@/lib/office";

const message = buildCallbackMessage(window.location.href);
// The code must not linger in the dialog's history or address bar.
window.history.replaceState(null, "", window.location.pathname);

const forward = async () => {
  await waitForOffice();
  const office = getOfficeRuntime();
  if (!office) {
    document.body.textContent =
      "Open stella from Outlook to finish signing in.";
    return;
  }
  office.context.ui.messageParent(message, {
    targetOrigin: window.location.origin,
  });
};

forward().catch(() => {
  document.body.textContent =
    "Signing in could not finish. Close this window and try again.";
});
