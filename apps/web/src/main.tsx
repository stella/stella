import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { RouterProvider } from "@tanstack/react-router";

import "@stella/ui/globals.css";
import { getRouter } from "@/router";

const rootElement = document.querySelector("#app");
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);

  root.render(
    <StrictMode>
      <RouterProvider router={getRouter()} />
    </StrictMode>,
  );
}
