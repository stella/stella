import type { PropsWithChildren } from "react";

// Faux app-window chrome shared by every product preview, so each one reads as a
// real product surface. Non-interactive (the outer ProductMediaFrame supplies the
// glass frame, border, and aspect ratio); colors come from the same semantic
// tokens the rest of the landing uses, so previews adapt to the theme.
type PreviewSurfaceProps = PropsWithChildren<{ title: string }>;

const DOT = (opacity: number) => ({
  background: `color-mix(in srgb, var(--muted-foreground) ${opacity}%, transparent)`,
});

export const PreviewSurface = ({ title, children }: PreviewSurfaceProps) => (
  <div
    className="pointer-events-none flex h-full w-full flex-col select-none"
    style={{
      background: "color-mix(in srgb, var(--card) 60%, var(--background))",
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
