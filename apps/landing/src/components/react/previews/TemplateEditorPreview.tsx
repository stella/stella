import { PreviewSurface } from "./PreviewSurface";

// Mocks stella's template editor: a legal template carrying {{variable}}
// placeholders and {{#directive}} blocks (if / each) rendered as colored bands
// with connector lines. Static lookalike; the only motion is one placeholder
// crossfading to a resolved value, reading as "the template filling with data".
export const TemplateEditorPreview = () => (
  <PreviewSurface title="Template">
    <style>{FILL_KEYFRAMES}</style>
    <div className="pointer-events-none flex h-full w-full flex-col gap-2">
      <Divider label="Header" />

      <p
        className="text-[0.62rem] leading-relaxed"
        style={{
          color: "var(--foreground)",
          fontFamily: "Georgia, 'Times New Roman', serif",
          textAlign: "justify",
        }}
      >
        Lease Agreement for <Var>property.address</Var>
      </p>
      <p
        className="text-[0.62rem] leading-relaxed"
        style={{
          color: "var(--foreground)",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        Dated: <Var>agreement.date</Var>
      </p>

      <Divider label="Body" />

      <div
        className="rounded-sm py-1 ps-2"
        style={{
          borderInlineStart:
            "3px solid color-mix(in srgb, var(--foreground) 35%, transparent)",
          background: "color-mix(in srgb, var(--primary) 8%, transparent)",
        }}
      >
        <DirectiveLabel keyword="if" expr="agreement.isStandardTerms" />
        <p
          className="mt-0.5 text-[0.62rem] leading-relaxed"
          style={{
            color: "var(--foreground)",
            fontFamily: "Georgia, 'Times New Roman', serif",
          }}
        >
          Standard terms apply per § 1234.
        </p>

        <div className="relative mt-1" style={{ marginInlineStart: "14px" }}>
          <span
            className="absolute h-full w-px"
            style={{
              insetInlineStart: "-8px",
              top: 0,
              background: "color-mix(in srgb, var(--success) 35%, transparent)",
            }}
          />
          <div
            className="rounded-sm py-1 ps-2"
            style={{
              borderInlineStart:
                "3px solid color-mix(in srgb, var(--success) 45%, transparent)",
              background: "color-mix(in srgb, var(--success) 10%, transparent)",
            }}
          >
            <DirectiveLabel keyword="each" expr="party.signatories" />
            <p
              className="mt-0.5 text-[0.62rem] leading-relaxed"
              style={{
                color: "var(--foreground)",
                fontFamily: "Georgia, 'Times New Roman', serif",
              }}
            >
              <FillingVar raw="party.name" resolved="Jan Novák" />,{" "}
              <Var>party.email</Var>
            </p>
          </div>
        </div>
      </div>

      <Divider label="Footer" />

      <p
        className="text-[0.62rem] leading-relaxed"
        style={{
          color: "var(--foreground)",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        Amount: <Var>agreement.monthlyRent</Var> CZK
      </p>
    </div>
  </PreviewSurface>
);

const Divider = ({ label }: { label: string }) => (
  <div className="flex items-center gap-2">
    <span
      className="shrink-0 text-[0.5rem] font-medium tracking-wider uppercase"
      style={{ color: "var(--muted-foreground)" }}
    >
      {label}
    </span>
    <span
      className="h-px flex-1"
      style={{
        background: "color-mix(in srgb, var(--border) 70%, transparent)",
      }}
    />
  </div>
);

const DirectiveLabel = ({
  keyword,
  expr,
}: {
  keyword: string;
  expr: string;
}) => (
  <span
    className="text-[0.55rem] font-medium tracking-wide"
    style={{ color: "var(--muted-foreground)" }}
  >
    <span style={{ color: "var(--foreground)" }}>{keyword}</span>
    {"  "}
    {expr}
  </span>
);

const VAR_STYLE = {
  background: "rgba(217, 119, 6, 0.18)",
  color: "rgb(217, 119, 6)",
} as const;

const Var = ({ children }: { children: string }) => (
  <mark
    className="rounded-sm px-0.5"
    style={{
      ...VAR_STYLE,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    }}
  >
    {`{{${children}}}`}
  </mark>
);

// One placeholder that crossfades between its raw {{…}} highlight and a resolved
// value: two stacked spans share a grid cell so the box never reflows.
const FillingVar = ({ raw, resolved }: { raw: string; resolved: string }) => (
  <span className="relative inline-grid align-baseline">
    <mark
      className="col-start-1 row-start-1 rounded-sm px-0.5"
      style={{
        ...VAR_STYLE,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        animation: "template-var-raw 4s ease-in-out infinite",
      }}
    >
      {`{{${raw}}}`}
    </mark>
    <span
      className="col-start-1 row-start-1 px-0.5"
      style={{
        color: "var(--foreground)",
        fontFamily: "Georgia, 'Times New Roman', serif",
        animation: "template-var-resolved 4s ease-in-out infinite",
      }}
    >
      {resolved}
    </span>
  </span>
);

const FILL_KEYFRAMES = `
  @keyframes template-var-raw {
    0%, 38% { opacity: 1; }
    50%, 88% { opacity: 0; }
    100% { opacity: 1; }
  }
  @keyframes template-var-resolved {
    0%, 38% { opacity: 0; }
    50%, 88% { opacity: 1; }
    100% { opacity: 0; }
  }
`;
