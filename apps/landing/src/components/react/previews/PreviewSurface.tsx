import type { PropsWithChildren } from "react";

// Faux app-window chrome shared by every product preview, so each one reads as a
// real product surface. This is the preview's own window (border, radius,
// shadow), matching the frameless language every other media type on product
// pages uses (MacWindow, CliMcpPreview's mac-window scenes, a plain image's
// own border+shadow): ProductMediaFrame no longer wraps media in a glass
// frame, so the window has to carry its own edges. Colors come from the same
// semantic tokens the rest of the landing uses, so previews adapt to the
// theme.
type PreviewSurfaceProps = PropsWithChildren<{ title: string }>;

const DOT = (opacity: number) => ({
  background: `color-mix(in srgb, var(--muted-foreground) ${opacity}%, transparent)`,
});

export const PreviewSurface = ({ title, children }: PreviewSurfaceProps) => (
  <div
    className="pointer-events-none flex h-full w-full flex-col overflow-hidden rounded-[1.1rem] border select-none"
    style={{
      borderColor: "color-mix(in srgb, var(--foreground) 11%, transparent)",
      // --card is translucent in the dark theme; composite it over the page
      // background for an opaque window instead of a translucency artifact.
      background: "linear-gradient(var(--card), var(--card)) var(--background)",
      boxShadow: "0 42px 110px -54px rgba(15, 23, 42, 0.5)",
    }}
    aria-hidden="true"
  >
    <div
      className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2"
      style={{
        borderColor: "color-mix(in srgb, var(--border) 65%, transparent)",
      }}
    >
      <span className="h-2 w-2 rounded-full" style={DOT(30)} />
      <span className="h-2 w-2 rounded-full" style={DOT(20)} />
      <span className="h-2 w-2 rounded-full" style={DOT(14)} />
      <span
        className="ms-2 truncate text-[0.6rem] font-medium tracking-wide"
        style={{
          color: "color-mix(in srgb, var(--muted-foreground) 80%, transparent)",
        }}
      >
        {title}
      </span>
    </div>
    <div className="relative min-h-0 flex-1 overflow-hidden p-3">
      {children}
    </div>
  </div>
);
