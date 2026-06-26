import { PreviewSurface } from "./PreviewSurface";

// Modeled on the app's review table: documents as rows, AI-extracted fields as
// typed columns (text, date, select pill). The Risk column re-extracts on a
// loop (spinner + skeleton -> resolved pill, staggered down the column) so the
// surface always reads as live AI extraction. Pure mock data + tokens + CSS.

type Risk = "Low" | "Medium" | "High";

type Doc = {
  name: string;
  parties: string;
  law: string;
  term: string;
  risk: Risk;
};

const DOCS: readonly Doc[] = [
  { name: "MSA — Acme Corp", parties: "Acme · Northwind", law: "England & Wales", term: "Mar 31", risk: "Low" },
  { name: "NDA — Globex", parties: "Globex · stella", law: "Delaware", term: "Sep 30", risk: "Medium" },
  { name: "DPA — Initech", parties: "Initech · Hooli", law: "Germany", term: "Dec 31", risk: "Low" },
  { name: "SoW — Soylent", parties: "Soylent · Umbrella", law: "Czechia", term: "Jun 30", risk: "High" },
];

// Mid-tone status colors that stay legible on both the light and dark surface.
const RISK_STYLE: Record<Risk, { bg: string; fg: string }> = {
  Low: { bg: "rgba(22, 163, 74, 0.16)", fg: "rgb(22, 163, 74)" },
  Medium: { bg: "rgba(217, 119, 6, 0.16)", fg: "rgb(217, 119, 6)" },
  High: { bg: "rgba(220, 38, 38, 0.16)", fg: "rgb(220, 38, 38)" },
};

const GRID = "1.7fr 1.1fr 1.1fr 0.6fr 0.7fr";
const HEADERS = ["Document", "Parties", "Governing law", "Term", "Risk"] as const;

const muted = (opacity: number) =>
  `color-mix(in srgb, var(--muted-foreground) ${opacity}%, transparent)`;
const fg = (opacity: number) =>
  `color-mix(in srgb, var(--foreground) ${opacity}%, transparent)`;

const FileGlyph = () => (
  <svg
    className="h-3 w-3 shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    style={{ color: muted(55) }}
  >
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
  </svg>
);

const Spinner = () => (
  <svg
    className="trp-spin h-3 w-3 shrink-0"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.5}
    style={{ color: muted(60) }}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const RiskPill = ({ risk }: { risk: Risk }) => (
  <span
    className="rounded-full px-1.5 py-px text-[0.55rem] font-medium"
    style={{ background: RISK_STYLE[risk].bg, color: RISK_STYLE[risk].fg }}
  >
    {risk}
  </span>
);

export const TabularReviewPreview = () => (
  <PreviewSurface title="Review · 24 documents">
    <style>{`
      @keyframes trp-rowin { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
      @keyframes trp-spin { to { transform: rotate(360deg); } }
      @keyframes trp-value { 0%, 14% { opacity: 0; } 30%, 86% { opacity: 1; } 100% { opacity: 0; } }
      @keyframes trp-pending { 0%, 14% { opacity: 1; } 30%, 100% { opacity: 0; } }
      .trp-row { animation: trp-rowin 0.45s ease-out both; }
      .trp-spin { animation: trp-spin 0.85s linear infinite; transform-origin: center; }
      .trp-value { animation: trp-value 5s ease-in-out infinite; }
      .trp-pending { position: absolute; inset: 0; display: flex; align-items: center; gap: 0.25rem; animation: trp-pending 5s ease-in-out infinite; }
    `}</style>

    <div className="flex h-full flex-col gap-2 text-[0.6rem]">
      <div
        className="grid items-center gap-x-3 pb-1.5"
        style={{
          gridTemplateColumns: GRID,
          borderBottom: `1px solid ${muted(28)}`,
        }}
      >
        {HEADERS.map((h, i) => (
          <span
            key={h}
            className="truncate font-medium tracking-wide"
            style={{ color: i >= 3 ? muted(95) : muted(70) }}
          >
            {h}
          </span>
        ))}
      </div>

      {DOCS.map((doc, r) => (
        <div
          key={doc.name}
          className="trp-row grid items-center gap-x-3"
          style={{ gridTemplateColumns: GRID, animationDelay: `${r * 110}ms` }}
        >
          <span className="flex min-w-0 items-center gap-1.5" style={{ color: fg(82) }}>
            <FileGlyph />
            <span className="truncate">{doc.name}</span>
          </span>
          <span className="truncate" style={{ color: fg(68) }}>{doc.parties}</span>
          <span className="truncate" style={{ color: fg(68) }}>{doc.law}</span>
          <span style={{ color: muted(95) }}>{doc.term}</span>
          <span className="relative flex items-center">
            <span className="trp-value" style={{ animationDelay: `${r * 480}ms` }}>
              <RiskPill risk={doc.risk} />
            </span>
            <span className="trp-pending" style={{ animationDelay: `${r * 480}ms` }}>
              <Spinner />
              <span className="h-2 w-7 rounded-full" style={{ background: muted(22) }} />
            </span>
          </span>
        </div>
      ))}
    </div>
  </PreviewSurface>
);
