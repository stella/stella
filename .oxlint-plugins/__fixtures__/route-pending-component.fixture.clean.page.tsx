// Passive regression fixture for
// `route-pending-component/page-module-shell`: a page renders the shell its
// sibling pending module exports.

// expect-clean: route-pending-component/page-module-shell
import { FixtureShell } from "./route-pending-component.fixture.clean.pending";

export const FixturePage = () => <FixtureShell rows={<p>Loaded rows</p>} />;
