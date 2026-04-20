import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { CancelledError } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import "@/fonts.css";
import "@stella/ui/globals.css";
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

  root.render(
    <StrictMode>
      <RouterProvider router={getRouter()} />
    </StrictMode>,
  );
}
