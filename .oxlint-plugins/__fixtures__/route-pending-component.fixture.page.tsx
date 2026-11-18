/* oxlint-disable route-pending-component/page-module-shell -- passive regression fixture: this page draws its own shell instead of its sibling pending module's, which the rule must flag */

// Passive regression fixture for
// `route-pending-component/page-module-shell`.

export const UnpairedPage = () => <section>Loaded rows</section>;
