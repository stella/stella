import { useRef } from "react";
import { createRoot } from "react-dom/client";

import { IntlProvider } from "use-intl";

import { AnnotationToolbar } from "../../src/components/legal-reader/annotations/annotation-toolbar";
import messages from "../../src/i18n/langs/en.json" with { type: "json" };
import { resolveActionCapabilities } from "../../src/lib/organization/feature-access/action-capabilities.logic";
import { ActionCapabilitiesProvider } from "../../src/lib/organization/feature-access/capability-actions";

const paragraph =
  "The court of appeal confirmed the judgment of the first instance court and held that the contract was void for its conflict with good morals. ";

const Fixture = () => {
  const root = useRef<HTMLElement>(null);
  return (
    <>
      <article
        data-testid="reader"
        ref={root}
        style={{
          width: 520,
          height: 600,
          overflow: "auto",
          padding: "24px 48px",
          fontSize: 16,
          lineHeight: "24px",
        }}
      >
        {Array.from({ length: 14 }, (_, index) => (
          <p
            data-anchor={`p-${index}`}
            data-line={index}
            key={index}
            style={{ margin: "0 0 24px" }}
          >
            {paragraph.repeat(2)}
          </p>
        ))}
      </article>
      <footer data-testid="after-reader">Text after the reader.</footer>
      <AnnotationToolbar
        activeAnnotation={null}
        activeSpans={[]}
        controller={{
          create: () => undefined,
          remove: () => undefined,
          update: () => undefined,
        }}
        mode="authenticated"
        onActivateAnnotation={() => undefined}
        onClearActive={() => undefined}
        onExplain={() => undefined}
        scrollContainerRef={root}
        target={{
          type: "decision",
          id: "decision-1",
          caseNumber: "Test decision",
          caseNumberType: "case-number",
          country: "CZ",
          court: "Court",
          decisionDate: null,
          decisionType: null,
          ecli: null,
          name: null,
        }}
      />
    </>
  );
};

const container = window.document.querySelector("#fixture");
if (container !== null) {
  createRoot(container).render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ActionCapabilitiesProvider
        value={resolveActionCapabilities({
          role: "member",
          ai: true,
          deepl: false,
          ocr: false,
          desktop: "none",
          settings: undefined,
        })}
      >
        <Fixture />
      </ActionCapabilitiesProvider>
    </IntlProvider>,
  );
}
