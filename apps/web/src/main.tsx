import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import "@/fonts.css";
import "@stll/ui/globals.css";
import { initializeI18n } from "@/i18n/i18n-store";
import { getRouter } from "@/router";

const rootElement = document.querySelector("#app");
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement, {
    onCaughtError: (error) => {
      // CancelledError is benign — React Query throws it during route
      // transitions when a suspended query unmounts. Suppress the default
      // React dev-mode console.error for this case.
      if (error instanceof CancelledError) {
        return;
      }
      // eslint-disable-next-line no-console
      console.error(error);
    },
  });

  const router = getRouter();

  void initializeI18n().finally(() => {
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
  });
}
