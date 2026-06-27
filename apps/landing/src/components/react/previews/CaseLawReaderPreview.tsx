import { PreviewSurface } from "./PreviewSurface";

// Mocks the case-law reader: a court decision with preserved structure (header,
// holding, editorial supplement) plus a jurisdiction switcher. Static lookalike;
// the only motion is a slow CSS sweep that reads as an "AI reading" cue.
export const CaseLawReaderPreview = () => (
  <PreviewSurface title="Case-law reader · 6 Afs 34/2021">
    <style>{SWEEP_KEYFRAMES}</style>
    <div className="pointer-events-none flex h-full w-full flex-col gap-2.5">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span
            className="text-[0.55rem] tracking-wide"
            style={{ color: "var(--muted-foreground)" }}
          >
            Nejvyšší soud
          </span>
          <span
            className="text-[0.75rem] font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            sp. zn. 6 Afs 34/2021
          </span>
          <span
            className="text-[0.55rem]"
            style={{ color: "var(--muted-foreground)" }}
          >
            12. 3. 2024
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {JURISDICTIONS.map((j) => (
            <span
              key={j.code}
              className="rounded px-1.5 py-0.5 text-[0.6rem] font-medium"
              style={
                j.active
                  ? {
                      background:
                        "color-mix(in srgb, var(--primary) 16%, transparent)",
                      color: "var(--primary)",
                    }
                  : { color: "var(--muted-foreground)" }
              }
            >
              {j.code}
            </span>
          ))}
        </div>
      </header>

      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded"
        style={{ background: "var(--background)" }}
      >
        <div
          className="absolute inset-x-0 h-[2px]"
          style={{
            top: 0,
            background: "color-mix(in srgb, var(--primary) 45%, transparent)",
            animation: "case-reader-sweep 5.5s ease-in-out infinite",
          }}
        />
        <div className="flex flex-col gap-2 p-2.5">
          <p
            className="ps-2 text-[0.62rem] leading-relaxed"
            style={{
              color: "var(--muted-foreground)",
              textAlign: "justify",
              borderLeft:
                "2px solid color-mix(in srgb, var(--primary) 35%, transparent)",
            }}
          >
            Nejvyšší správní soud přezkoumal napadené rozhodnutí v rozsahu
            uplatněných kasačních námitek a dospěl k závěru, že kasační stížnost
            není důvodná.{" "}
            <strong style={{ color: "var(--foreground)" }}>
              Daňový subjekt nese důkazní břemeno ohledně skutečností, které
              tvrdí ve svém daňovém přiznání.
            </strong>{" "}
            Správce daně proto nepochybil, požadoval-li doložení uskutečnění
            zdanitelného plnění.
          </p>
          <p
            className="text-[0.62rem] leading-relaxed"
            style={{ color: "var(--muted-foreground)", textAlign: "justify" }}
          >
            Z obsahu správního spisu je zřejmé, že stěžovatel své tvrzení
            relevantními důkazními prostředky neprokázal. Soud neshledal důvody
            pro odchýlení se od ustálené judikatury.
          </p>
        </div>
      </div>

      <div
        className="shrink-0 rounded border p-2"
        style={{
          borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
          background: "color-mix(in srgb, var(--card) 70%, transparent)",
        }}
      >
        <span
          className="text-[0.5rem] font-medium tracking-wider uppercase"
          style={{ color: "var(--muted-foreground)" }}
        >
          Právní věta
        </span>
        <p
          className="mt-0.5 text-[0.6rem] leading-snug"
          style={{ color: "var(--foreground)" }}
        >
          Důkazní břemeno o uskutečnění zdanitelného plnění tíží daňový subjekt.
        </p>
        <span
          className="mt-1.5 block text-[0.5rem] font-medium tracking-wider uppercase"
          style={{ color: "var(--muted-foreground)" }}
        >
          Abstrakt
        </span>
        <p
          className="mt-0.5 text-[0.6rem] leading-snug"
          style={{ color: "var(--muted-foreground)" }}
        >
          Kasační stížnost zamítnuta; rozhodnutí správce daně potvrzeno jako
          souladné se zákonem.
        </p>
      </div>
    </div>
  </PreviewSurface>
);

const JURISDICTIONS = [
  { code: "CZ", active: true },
  { code: "SK", active: false },
  { code: "PL", active: false },
] as const;

const SWEEP_KEYFRAMES = `
  @keyframes case-reader-sweep {
    0% { transform: translateY(0); opacity: 0; }
    15% { opacity: 0.7; }
    85% { opacity: 0.7; }
    100% { transform: translateY(2000%); opacity: 0; }
  }
`;
