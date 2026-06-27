import { PreviewSurface } from "./PreviewSurface";

// Static lookalike of the app's matter workspace: a left nav rail (matter sections
// + team) and a documents list with status pills. Pure markup; the only motion is
// a slow highlight that drifts down the list via the @keyframes below, reading as a
// "live" workspace without any client JS or hooks.
export const WorkspacePreview = () => (
  <PreviewSurface title="Acme v. Northwind">
    <style>{`
      @keyframes ws-row-rise {
        0% { opacity: 0; transform: translateY(4px); }
        100% { opacity: 1; transform: translateY(0); }
      }
      @keyframes ws-scan {
        0%, 100% { opacity: 0; }
        50% { opacity: 1; }
      }
    `}</style>

    <div className="flex h-full min-h-0 gap-3">
      <aside
        className="flex w-1/3 shrink-0 flex-col gap-2 border-e pe-3"
        style={{
          borderColor: "color-mix(in srgb, var(--border) 65%, transparent)",
        }}
      >
        <span
          className="text-[0.55rem] font-medium tracking-wide uppercase"
          style={{
            color:
              "color-mix(in srgb, var(--muted-foreground) 70%, transparent)",
          }}
        >
          Matters
        </span>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavRow key={item.label} {...item} />
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-1.5">
          <span
            className="text-[0.55rem] font-medium tracking-wide uppercase"
            style={{
              color:
                "color-mix(in srgb, var(--muted-foreground) 70%, transparent)",
            }}
          >
            Team
          </span>
          <div className="flex">
            {TEAM.map((tint, i) => (
              <span
                key={tint}
                className="h-3.5 w-3.5 rounded-full border"
                style={{
                  marginLeft: i === 0 ? 0 : "-0.25rem",
                  background: `color-mix(in srgb, var(--${tint}) 30%, var(--card))`,
                  borderColor:
                    "color-mix(in srgb, var(--background) 80%, transparent)",
                }}
              />
            ))}
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex items-center justify-between gap-2">
          <span
            className="text-[0.65rem] font-medium"
            style={{ color: "var(--foreground)" }}
          >
            Documents{" "}
            <span style={{ color: "var(--muted-foreground)" }}>· 18</span>
          </span>
          <div className="flex gap-1">
            {["Filter", "Sort"].map((chip) => (
              <span
                key={chip}
                className="rounded border px-1.5 py-0.5 text-[0.55rem]"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--border) 70%, transparent)",
                  color: "var(--muted-foreground)",
                }}
              >
                {chip}
              </span>
            ))}
          </div>
        </header>

        <ul className="relative flex flex-col gap-1">
          {DOCS.map((doc, i) => (
            <DocRow key={doc.name} index={i} {...doc} />
          ))}
        </ul>
      </section>
    </div>
  </PreviewSurface>
);

type NavItem = {
  label: string;
  tint: string;
  active?: boolean;
};

const NAV: NavItem[] = [
  { label: "Documents", tint: "primary", active: true },
  { label: "Chat", tint: "muted-foreground" },
  { label: "Review", tint: "muted-foreground" },
  { label: "Timeline", tint: "muted-foreground" },
  { label: "Templates", tint: "muted-foreground" },
];

const TEAM = ["primary", "success", "muted-foreground"];

type Pill = "Reviewed" | "Draft" | "New";

type Doc = {
  name: string;
  pill: Pill;
};

const DOCS: Doc[] = [
  { name: "MSA — Acme Corp", pill: "Reviewed" },
  { name: "Witness statement.docx", pill: "Draft" },
  { name: "Exhibit B — Invoices.pdf", pill: "New" },
  { name: "NDA — Northwind", pill: "Reviewed" },
];

const NavRow = ({ label, tint, active }: NavItem) => (
  <span
    className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[0.6rem]"
    style={
      active
        ? {
            background: "color-mix(in srgb, var(--primary) 12%, transparent)",
            color: "var(--primary)",
            fontWeight: 500,
          }
        : { color: "var(--muted-foreground)" }
    }
  >
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{
        background: active
          ? "var(--primary)"
          : `color-mix(in srgb, var(--${tint}) 55%, transparent)`,
      }}
    />
    {label}
  </span>
);

const DocRow = ({ name, pill, index }: Doc & { index: number }) => (
  <li
    className="relative flex items-center gap-2 rounded border px-2 py-1.5"
    style={{
      borderColor: "color-mix(in srgb, var(--border) 55%, transparent)",
      background: "color-mix(in srgb, var(--card) 50%, transparent)",
      animation: `ws-row-rise 0.5s ease-out both`,
      animationDelay: `${index * 0.12}s`,
    }}
  >
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded"
      style={{
        background: "color-mix(in srgb, var(--primary) 8%, transparent)",
        animation: "ws-scan 6s ease-in-out infinite",
        animationDelay: `${index * 1.2}s`,
      }}
    />
    <FileGlyph />
    <span
      className="min-w-0 flex-1 truncate text-[0.6rem]"
      style={{ color: "var(--foreground)" }}
    >
      {name}
    </span>
    <StatusPill pill={pill} />
  </li>
);

const FileGlyph = () => (
  <svg
    width="9"
    height="11"
    viewBox="0 0 9 11"
    fill="none"
    className="shrink-0"
    style={{
      color: "color-mix(in srgb, var(--muted-foreground) 65%, transparent)",
    }}
    aria-hidden="true"
  >
    <path
      d="M1 1.5A.5.5 0 0 1 1.5 1H5l3 3v5.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-8Z"
      stroke="currentColor"
      strokeWidth="0.8"
    />
    <path d="M5 1v3h3" stroke="currentColor" strokeWidth="0.8" />
  </svg>
);

const PILL_TINT: Record<Pill, string> = {
  Reviewed: "success",
  Draft: "muted-foreground",
  New: "primary",
};

const StatusPill = ({ pill }: { pill: Pill }) => {
  const tint = PILL_TINT[pill];
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-0.5 text-[0.5rem] font-medium"
      style={{
        background: `color-mix(in srgb, var(--${tint}) 14%, transparent)`,
        color: `color-mix(in srgb, var(--${tint}) 85%, var(--foreground))`,
      }}
    >
      {pill}
    </span>
  );
};
