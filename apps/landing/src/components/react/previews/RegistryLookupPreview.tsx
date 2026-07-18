import { PreviewSurface } from "./PreviewSurface";

// Mocks the company-registry lookup: a search field, a registry switcher, and a
// result card with typed official fields pulled from a national registry, plus a
// "pull into matter" affordance. Static lookalike with fictional company data;
// the only motion is a caret blink and a soft pulse on the pull chip.
export const RegistryLookupPreview = () => (
  <PreviewSurface title="Registry lookup · ARES">
    <style>{REGISTRY_KEYFRAMES}</style>
    <div className="pointer-events-none flex h-full w-full flex-col gap-2.5">
      <header className="flex items-center justify-between gap-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded border px-2 py-1"
          style={{
            borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
            background: "var(--background)",
          }}
        >
          <SearchGlyph />
          <span
            className="truncate text-[0.65rem] font-medium"
            style={{ color: "var(--foreground)" }}
          >
            Example Holding s.r.o.
          </span>
          <span
            className="inline-block"
            style={{
              color: "var(--primary)",
              animation: "registry-lookup-caret 1.1s steps(1) infinite",
            }}
          >
            ▍
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {REGISTRIES.map((registry) => (
            <span
              key={registry.code}
              className="rounded px-1.5 py-0.5 text-[0.6rem] font-medium"
              style={
                registry.active
                  ? {
                      background:
                        "color-mix(in srgb, var(--primary) 16%, transparent)",
                      color: "var(--primary)",
                    }
                  : { color: "var(--muted-foreground)" }
              }
            >
              {registry.code}
            </span>
          ))}
        </div>
      </header>

      <div
        className="min-h-0 flex-1 overflow-hidden rounded border p-2.5"
        style={{
          borderColor: "color-mix(in srgb, var(--border) 70%, transparent)",
          background: "color-mix(in srgb, var(--card) 70%, transparent)",
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className="text-[0.72rem] font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            Example Holding s.r.o.
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[0.55rem] font-medium"
            style={{
              background: "color-mix(in srgb, var(--success) 14%, transparent)",
              color: "var(--success)",
            }}
          >
            Active
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
          {FIELDS.map((field) => (
            <div key={field.label} className="flex min-w-0 flex-col">
              <dt
                className="text-[0.5rem] font-medium tracking-wider uppercase"
                style={{ color: "var(--muted-foreground)" }}
              >
                {field.label}
              </dt>
              <dd
                className="truncate text-[0.62rem]"
                style={{ color: "var(--foreground)" }}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2">
        <span
          className="rounded px-2 py-1 text-[0.6rem] font-medium"
          style={{
            background: "var(--primary)",
            color: "var(--primary-foreground)",
            animation: "registry-lookup-pull 5s ease-in-out infinite",
          }}
        >
          Pull into matter
        </span>
        <span
          className="truncate text-[0.55rem]"
          style={{ color: "var(--muted-foreground)" }}
        >
          Official record · ARES, Czech Republic
        </span>
      </footer>
    </div>
  </PreviewSurface>
);

const REGISTRIES = [
  { code: "ARES", active: true },
  { code: "CH", active: false },
  { code: "KRS", active: false },
] as const;

// Fictional demo data: an obviously generic company, no real identifiers.
const FIELDS = [
  { label: "Registry", value: "ARES (CZ)" },
  { label: "Company no.", value: "000 00 000" },
  { label: "Seat", value: "Prague, Czech Republic" },
  { label: "Incorporated", value: "12 May 2019" },
  { label: "Representative", value: "J. Novak, managing director" },
  { label: "Legal form", value: "s.r.o." },
] as const;

const SearchGlyph = () => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    className="h-2.5 w-2.5 shrink-0"
    style={{ color: "var(--muted-foreground)" }}
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
    <path
      d="M10.5 10.5 14 14"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

const REGISTRY_KEYFRAMES = `
  @keyframes registry-lookup-caret {
    0%, 45% { opacity: 1; }
    50%, 95% { opacity: 0; }
    100% { opacity: 1; }
  }
  @keyframes registry-lookup-pull {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.75; }
  }
`;
