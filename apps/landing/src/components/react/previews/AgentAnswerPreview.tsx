import { PreviewSurface } from "./PreviewSurface";

// Static lookalike of stella's AI agent answering a legal question in chat with
// inline source citations. Pure markup; the only motion is a looping caret blink
// and a staggered fade-in of the citation chips, both via inline @keyframes.
export const AgentAnswerPreview = () => (
  <PreviewSurface title="Agent">
    <style>{`
      @keyframes agentAnswerCaret {
        0%, 45% { opacity: 1; }
        50%, 95% { opacity: 0; }
        100% { opacity: 1; }
      }
      @keyframes agentAnswerChip {
        0%, 12% { opacity: 0; transform: translateY(3px); }
        28%, 88% { opacity: 1; transform: translateY(0); }
        100% { opacity: 0; transform: translateY(3px); }
      }
    `}</style>
    <div className="flex h-full flex-col gap-2.5">
      <div className="flex justify-end">
        <span
          className="max-w-[80%] truncate rounded-md px-2 py-1 text-[0.6rem]"
          style={{
            color: "var(--muted-foreground)",
            background:
              "color-mix(in srgb, var(--muted-foreground) 10%, transparent)",
          }}
        >
          What did the court hold on termination?
        </span>
      </div>

      <div className="flex max-w-[92%] flex-col gap-1.5">
        <p
          className="text-[0.66rem] leading-relaxed"
          style={{ color: "var(--foreground)" }}
        >
          The court in{" "}
          <span className="font-medium" style={{ color: "var(--primary)" }}>
            sp. zn. 6 Afs 34/2021
          </span>{" "}
          held that obligations under{" "}
          <span className="font-medium" style={{ color: "var(--primary)" }}>
            § 1751
          </span>{" "}
          must be met within 30 days.
          <span
            className="ms-0.5 inline-block"
            style={{
              color: "var(--primary)",
              animation: "agentAnswerCaret 1.1s steps(1) infinite",
            }}
          >
            ▍
          </span>
        </p>

        <ul className="flex flex-col gap-1 ps-0.5">
          {[
            "Damages capped at contract value",
            "Force majeure clause applies",
          ].map((item) => (
            <li
              key={item}
              className="flex items-center gap-1.5 text-[0.6rem]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <span
                className="h-1 w-1 shrink-0 rounded-full"
                style={{ background: "var(--muted-foreground)" }}
              />
              <span className="truncate">{item}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-1">
        <Chip glyph="doc" label="Decision_2021.pdf" delay="0s" />
        <Chip glyph="doc" label="Smlouva_NDA.docx" delay="0.18s" />
        <Chip glyph="globe" label="legislation.cz" delay="0.36s" external />
      </div>
    </div>
  </PreviewSurface>
);

type ChipProps = {
  glyph: "doc" | "globe";
  label: string;
  delay: string;
  external?: boolean;
};

const Chip = ({ glyph, label, delay, external }: ChipProps) => (
  <span
    className="flex max-w-[7rem] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.55rem]"
    style={{
      color: external ? "var(--success)" : "var(--muted-foreground)",
      borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
      background: "color-mix(in srgb, var(--card) 70%, transparent)",
      animation: `agentAnswerChip 6s ease-in-out ${delay} infinite`,
    }}
  >
    {glyph === "doc" ? <DocGlyph /> : <GlobeGlyph />}
    <span className="truncate">{label}</span>
  </span>
);

const DocGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    className="h-2 w-2 shrink-0"
    aria-hidden="true"
  >
    <path
      d="M4 1.5h5l3 3V14a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 4 14V2a.5.5 0 0 1 .5-.5z"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path
      d="M9 1.5V4.5h3"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

const GlobeGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    className="h-2 w-2 shrink-0"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M2 8h12M8 2c1.8 1.6 2.8 3.7 2.8 6S9.8 12.4 8 14C6.2 12.4 5.2 10.3 5.2 8S6.2 3.6 8 2z"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <path
      d="M11 3.2l2.4-.2-.2 2.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
