import { StrictMode } from "react";
import { HeadContent, RouterProvider } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import ReactDOM from "react-dom/client";

import "@stella/ui/globals.css";

import { getRouter } from "@/router";

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);

  root.render(
    <StrictMode>
      {createPortal(<HeadContent />, document.head)}
      <RouterProvider router={getRouter()} />
    </StrictMode>,
  );
}
