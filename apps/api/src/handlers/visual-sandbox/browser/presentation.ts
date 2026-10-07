import type { VisualTheme } from "@stll/api-contract/visual-theme";

declare const STELLA_VISUAL_FONT_FACES: string;

// Fallbacks render a standalone guest before the host supplies its theme.
const PRESENTATION = `
@layer stella-presentation { :root { color-scheme:light dark; --background:light-dark(#fff,#1c1c1c); --foreground:light-dark(#262626,#f5f5f5); --card:var(--background); --muted:light-dark(#f5f5f5,#262626); --muted-foreground:light-dark(#737373,#a3a3a3); --border:light-dark(#e5e5e5,#404040); --primary:var(--foreground); --primary-foreground:var(--background); --accent:var(--muted); --destructive:light-dark(#bd746e,#d49a93); --ring:var(--muted-foreground); --radius:.625rem; --font-sans:system-ui,sans-serif; --font-mono:ui-monospace,monospace; --chart-1:light-dark(#528bb8,#83b3d7); --chart-2:light-dark(#569b88,#85bda9); --chart-3:light-dark(#b28a48,#cfb079); --chart-4:light-dark(#9276b3,#b69acf); --chart-5:light-dark(#bd746e,#d49a93); --chart-6:light-dark(#6f93a0,#96bac5); --chart-7:light-dark(#9b9470,#bcb58c); --chart-8:light-dark(#a47e9c,#c3a1bb); font:14px/1.5 var(--font-sans); color:var(--foreground); background:transparent; -webkit-font-smoothing:antialiased } }
* { box-sizing:border-box }
body { margin:0; padding:0; overflow-wrap:anywhere }
h1,h2,h3 { line-height:1.25; font-weight:600; text-wrap:balance; margin-block:0 .75rem }
h1 { font-size:1.5rem } h2 { font-size:1.25rem } h3 { font-size:1rem }
p { margin-block:0 .75rem; text-wrap:pretty }
code,pre { font-family:var(--font-mono) }
.stella-stack { display:flex; flex-direction:column; gap:1rem; min-inline-size:0 }
.stella-row { display:flex; flex-wrap:wrap; align-items:center; gap:.75rem }
.stella-card { padding:1rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--card) }
body > .stella-card { border:0; padding:0; background:transparent }
.stella-muted { color:var(--muted-foreground) }
.stella-chart { block-size:320px; inline-size:100%; min-inline-size:0 }
.stella-table { inline-size:100%; border-collapse:collapse; font-variant-numeric:tabular-nums }
.stella-table th,.stella-table td { padding-block:.5rem; padding-inline:.75rem; text-align:start; border-block-end:1px solid var(--border) }
.stella-table th { color:var(--muted-foreground); font-weight:500 }
.stella-badge { display:inline-flex; align-items:center; padding:.125rem .5rem; border-radius:calc(var(--radius) / 2); background:var(--muted); color:var(--muted-foreground); font-size:.75rem; font-weight:500 }
a[data-stella-link] { color:var(--primary); text-decoration:none; text-underline-offset:3px; cursor:pointer }
a[data-stella-link]:hover { text-decoration:underline }
button,input,select { font:inherit; color:inherit }
.stella-button { display:inline-flex; align-items:center; justify-content:center; gap:.5rem; min-block-size:32px; padding:.375rem .75rem; border:1px solid transparent; border-radius:var(--radius); background:var(--primary); color:var(--primary-foreground); font-weight:500; cursor:pointer }
.stella-button:hover { background:color-mix(in srgb,var(--primary) 90%,var(--background)) }
.stella-button-secondary { background:var(--muted); color:var(--foreground); border-color:var(--border) }
.stella-button-ghost { background:transparent; color:var(--foreground) }
.stella-button-secondary:hover,.stella-button-ghost:hover { background:var(--accent) }
.stella-button:disabled { opacity:.64; cursor:not-allowed }
:focus-visible { outline:2px solid var(--ring); outline-offset:2px }
@media (pointer:coarse) { .stella-button,a[data-stella-link] { min-block-size:44px; min-inline-size:44px } }
`;

export const installVisualPresentation = (document: Document) => {
  const style = document.createElement("style");
  style.textContent = `${typeof STELLA_VISUAL_FONT_FACES === "string" ? STELLA_VISUAL_FONT_FACES : ""}${PRESENTATION}`;
  document.head.prepend(style);
};

export const applyVisualTheme = (document: Document, theme: VisualTheme) => {
  let style = document.getElementById("stella-theme");
  if (style === null) {
    style = document.createElement("style");
    style.id = "stella-theme";
    document.head.prepend(style);
  }
  // The caller validates host messages with the shared theme schema.
  style.textContent = `:root{color-scheme:${theme.appearance};${Object.entries(theme.variables).map(([name, value]) => `${name}:${value}`).join(";")}}`;
  document.defaultView?.dispatchEvent(new Event("stella-theme-change"));
};
