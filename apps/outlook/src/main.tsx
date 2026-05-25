import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import "./styles.css";

import { App } from "@/app";
import { I18nProvider } from "@/i18n";
import { waitForOffice } from "@/outlook";

const rootElement = document.querySelector("#root");

if (!rootElement) {
  panic("Root element not found");
}

const render = () => {
  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
};

waitForOffice()
  .then(render)
  .catch(() => render());
