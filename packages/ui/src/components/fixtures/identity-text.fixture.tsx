import { createRoot } from "react-dom/client";

import { panic } from "better-result";

import { IdentityText } from "../identity-text";
import { TooltipProvider } from "../tooltip";

const name = `${"Shared matter prefix ".repeat(20)}distinguishing suffix`;
const root = document.querySelector("#root") ?? panic("Missing fixture root");

createRoot(root).render(
  <TooltipProvider>
    <div className="flex gap-4 p-4">
      <section className="min-w-0 flex-1 space-y-4">
        <button className="flex w-full max-w-64 gap-2" data-testid="sidebar" type="button">
          <span aria-hidden>•</span>
          <IdentityText className="flex-1">{name}</IdentityText>
        </button>
        <article className="max-w-96">
          <h2 className="min-w-0">
            <a data-testid="card" href="#matter"><IdentityText>{name}</IdentityText></a>
          </h2>
        </article>
        <div className="flex max-w-64"><IdentityText className="flex-1">{name}</IdentityText></div>
        <div className="w-64"><IdentityText>Short name</IdentityText></div>
      </section>
      <aside aria-label="Inspector" className="hidden w-64 shrink-0" />
    </div>
  </TooltipProvider>,
);
