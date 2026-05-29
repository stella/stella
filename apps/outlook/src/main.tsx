import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import "./styles.css";

import { App } from "@/app";
import { OutlookIntlProvider } from "@/i18n";
import { initAuth } from "@/lib/auth";
import { waitForOffice } from "@/outlook";

const rootElement = document.querySelector("#root");

if (!rootElement) {
  panic("Root element not found");
}

const render = () => {
  initAuth();
  createRoot(rootElement).render(
    <StrictMode>
      <OutlookIntlProvider>
        <App />
      </OutlookIntlProvider>
    </StrictMode>,
  );
};

waitForOffice()
  .then(render)
  .catch(() => render());
