// The sign-in dialog's first page. Office opens a dialog only on the task
// pane's origin; this page moves it on to the authorization request the task
// pane built, provided that request targets a configured stella origin.

import { env } from "@/env";
import { readDialogStartTarget } from "@/lib/oauth/authorize";

const target = readDialogStartTarget({
  allowedOrigins: [env.apiOrigin, env.webOrigin],
  location: window.location.href,
});

if (target === null) {
  document.body.textContent =
    "This sign-in link is not valid. Close this window and try again from Outlook.";
} else {
  window.location.replace(target);
}
