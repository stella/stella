// Passive regression fixture for
// `inspector-header-title/inspector-header-title`.

declare const title: string;

// Raw panel header titles must be rejected.
export const _rawPanelHeader = (
  <header>
    {/* oxlint-disable-next-line inspector-header-title/inspector-header-title */}
    <h2>{title}</h2>
  </header>
);

// expect-clean: inspector-header-title/inspector-header-title
export const _bodySection = (
  <section className="border-b">
    <h2>History</h2>
  </section>
);
