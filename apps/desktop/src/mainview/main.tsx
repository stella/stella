import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { defaultMessages, DesktopIntlProvider, loadMessages } from "../i18n";
import App from "./App";
import "./index.css";

const Root = () => {
  const [messages, setMessages] = useState(defaultMessages);

  useEffect(() => {
    void loadMessages().then(setMessages);
  }, []);

  return (
    <StrictMode>
      <DesktopIntlProvider messages={messages}>
        <App />
      </DesktopIntlProvider>
    </StrictMode>
  );
};

const rootElement = document.querySelector("#root");

if (!(rootElement instanceof HTMLDivElement)) {
  panic("Missing root element for stella desktop.");
}

createRoot(rootElement).render(<Root />);
