import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { panic } from "better-result";

import { InspectorEntityTab } from "../../inspector/entity-tab";
import { DocumentIdentityBadge } from "../document-identity-badge";
import { TooltipProvider } from "../tooltip";

const LOCALE =
  new URL(window.location.href).searchParams.get("lang") === "ar" ? "ar" : "en";
const DIRECTION = LOCALE === "ar" ? "rtl" : "ltr";
const TITLE =
  LOCALE === "ar"
    ? "172/2026 Sb., قانون السجلات العامة"
    : "172/2026 Sb., zákon o veřejných listinách";
document.documentElement.lang = LOCALE;
document.documentElement.dir = DIRECTION;

const Fixture = () => (
  <DirectionProvider direction={DIRECTION}>
    <TooltipProvider>
      <main className="flex flex-col gap-4 p-4">
        <section data-testid="narrow" className="w-10">
          <DocumentIdentityBadge
            identity={{ kind: "statute", number: "172", year: "2026" }}
            title={TITLE}
          />
        </section>
        <section data-testid="room" className="w-[52px]">
          <DocumentIdentityBadge
            identity={{ kind: "statute", number: "172", year: "2026" }}
            title={TITLE}
          />
        </section>
        <section data-testid="wide" className="w-40">
          <DocumentIdentityBadge
            identity={{ kind: "statute", number: "172", year: "2026" }}
            title={TITLE}
          />
        </section>
        <section data-testid="rail" className="w-12">
          <InspectorEntityTab
            active
            label={TITLE}
            inactiveIcon="legible"
            icon={
              <DocumentIdentityBadge
                identity={{ kind: "statute", number: "172", year: "2026" }}
              />
            }
          />
          <InspectorEntityTab
            active={false}
            label={TITLE}
            inactiveIcon="legible"
            icon={
              <DocumentIdentityBadge
                identity={{ kind: "statute", number: "12345", year: "2001" }}
              />
            }
          />
          <InspectorEntityTab
            active
            label="Supreme Court of the United States"
            inactiveIcon="legible"
            icon={
              <DocumentIdentityBadge
                identity={{
                  kind: "decision",
                  courtAbbreviation: "SCOTUS",
                  courtTier: "supreme",
                }}
              />
            }
          />
          <InspectorEntityTab
            active={false}
            label="Ústavní soud"
            inactiveIcon="legible"
            icon={
              <DocumentIdentityBadge
                identity={{
                  kind: "decision",
                  courtAbbreviation: "ÚS",
                  courtTier: "constitutional",
                }}
              />
            }
          />
        </section>
      </main>
    </TooltipProvider>
  </DirectionProvider>
);

const root = document.querySelector("#root");
if (root === null) {
  panic("Document identity fixture root missing");
}
createRoot(root).render(<Fixture />);
