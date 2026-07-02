import "./styles.css";
import "@stll/folio-react/editor.css";
import { createRoot } from "react-dom/client";

import { IntlProvider } from "use-intl";

import { getFolioMessages } from "@stll/folio-react/messages";

import appMessages from "../../web/src/i18n/langs/en.json";
import { App } from "./App";

// The playground only renders the folio editor, so the package's own
// `folio.*` catalog (a superset of the app's) replaces the app namespace;
// every other namespace comes from the app messages.
const messages = { ...appMessages, ...getFolioMessages("en") };

const container = document.querySelector("#app");
if (container) {
  const root = createRoot(container);
  root.render(
    <IntlProvider
      locale="en"
      messages={messages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <App />
    </IntlProvider>,
  );
}
