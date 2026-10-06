// The guest owns these semantic tokens; its classes need no authored stylesheet.
const PRESENTATION = `
:root { color-scheme: light dark; --background:light-dark(#fff,#1c1c1c); --foreground:light-dark(#262626,#f5f5f5); --muted:light-dark(#f5f5f5,#262626); --muted-foreground:light-dark(#737373,#a3a3a3); --border:light-dark(#e5e5e5,#404040); --primary:var(--foreground); --primary-foreground:var(--background); font-family:system-ui,sans-serif; color:var(--foreground); background:var(--background) }
body { margin:0; padding:1rem; box-sizing:border-box }
.stella-light { color-scheme:light }
.stella-dark { color-scheme:dark }
.stella-stack { display:flex; flex-direction:column; gap:1rem }
.stella-row { display:flex; flex-wrap:wrap; align-items:center; gap:.75rem }
.stella-card { padding:1rem; border:1px solid var(--border); border-radius:.5rem; background:var(--background) }
.stella-muted { color:var(--muted-foreground) }
.stella-chart { min-block-size:20rem; inline-size:100% }
.stella-table { inline-size:100%; border-collapse:collapse }
.stella-table th,.stella-table td { padding-block:.5rem; padding-inline:.75rem; text-align:start; border-block-end:1px solid var(--border) }
a[data-stella-link] { text-decoration:underline; cursor:pointer }
button,input,select { font:inherit; color:inherit }
:focus-visible { outline:2px solid var(--primary); outline-offset:2px }
`;

export const installVisualPresentation = (document: Document) => {
  const style = document.createElement("style");
  style.textContent = PRESENTATION;
  document.head.append(style);
};
