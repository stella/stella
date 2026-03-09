import { StrictMode } from "react";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import "@stella/ui/globals.css";

import { getRouter } from "@/router";

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);

  root.render(
    <StrictMode>
      <RouterProvider router={getRouter()} />
    </StrictMode>,
  );
}
