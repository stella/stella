import { PreviewSurface } from "./PreviewSurface";

// Static marketing lookalike of stella's anonymization / redaction surface: a legal
// paragraph where detected entity spans are masked in place as labeled pills. One span
// loops between its raw name and the masked pill to read as "detecting & masking".
// Animation is pure CSS (@keyframes) so the component stays hook-free and client-JS-free.

const ENTITY = {
  person: { bg: "rgba(22,163,74,.16)", fg: "rgb(22,163,74)" },
  organization: { bg: "rgba(37,99,235,.16)", fg: "rgb(37,99,235)" },
  id: { bg: "rgba(217,119,6,.16)", fg: "rgb(217,119,6)" },
} as const;

type EntityType = keyof typeof ENTITY;

const pillStyle = (type: EntityType) => ({
  backgroundColor: ENTITY[type].bg,
  color: ENTITY[type].fg,
});

const Pill = ({ type, children }: { type: EntityType; children: string }) => (
  <span
    className="mx-px rounded px-1 align-baseline text-[0.62rem] font-medium whitespace-nowrap"
    style={pillStyle(type)}
  >
    {children}
  </span>
);

export const AnonymizationPreview = () => (
  <PreviewSurface title="Anonymization">
    <style>{`
      @keyframes stella-anon-raw {
        0%, 38% { opacity: 1; }
        50%, 88% { opacity: 0; }
        100% { opacity: 1; }
      }
      @keyframes stella-anon-mask {
        0%, 38% { opacity: 0; }
        50%, 88% { opacity: 1; }
        100% { opacity: 0; }
      }
    `}</style>
    <div className="flex h-full flex-col justify-between">
      <p
        className="text-justify text-[0.7rem] leading-relaxed"
        style={{ color: "var(--foreground)" }}
      >
        This agreement is made between{" "}
        <Pill type="person">Jonathan Meredith</Pill>, tax no.{" "}
        {/* live detect-and-mask span: raw id crossfades into the masked pill */}
        <span className="relative inline-block align-baseline">
          <span
            className="whitespace-nowrap"
            style={{
              animation: "stella-anon-raw 3.5s ease-in-out infinite",
              color: "var(--muted-foreground)",
            }}
          >
            542-11-8837
          </span>
          <span
            className="absolute inset-0 flex items-center justify-center"
            style={{ animation: "stella-anon-mask 3.5s ease-in-out infinite" }}
          >
            <Pill type="id">542-11-8837</Pill>
          </span>
        </span>
        , of <Pill type="organization">Aldercross Chambers</Pill>, and{" "}
        <Pill type="organization">Northwind Trading Ltd</Pill>, registered under{" "}
        <Pill type="id">reg. no. 09182736</Pill>, for the provision of legal
        services.
      </p>
      <div
        className="mt-2 flex items-center gap-3 border-t pt-2 text-[0.58rem]"
        style={{
          borderColor: "color-mix(in srgb, var(--border) 65%, transparent)",
          color: "var(--muted-foreground)",
        }}
      >
        <LegendItem type="person" label="Person" />
        <LegendItem type="organization" label="Organization" />
        <LegendItem type="id" label="ID" />
      </div>
    </div>
  </PreviewSurface>
);

const LegendItem = ({ type, label }: { type: EntityType; label: string }) => (
  <span className="flex items-center gap-1">
    <span
      className="h-1.5 w-1.5 rounded-full"
      style={{ backgroundColor: ENTITY[type].fg }}
    />
    {label}
  </span>
);
