import "./styles.css";
import "../../../packages/folio/src/styles/editor.css";
import { createRoot } from "react-dom/client";

import { IntlProvider } from "use-intl";

import messages from "../../web/src/i18n/langs/en.json";
import { App } from "./App";

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
