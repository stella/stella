// Passive regression fixture for
// `route-pending-component/page-module-shell`: the disabled line must be
// flagged, since this page draws its own shell instead of its sibling
// pending module's.

// oxlint-disable-next-line route-pending-component/page-module-shell
export const UnpairedPage = () => <section>Loaded rows</section>;
