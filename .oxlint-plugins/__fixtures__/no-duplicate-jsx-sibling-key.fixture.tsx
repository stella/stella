// Passive regression fixture for
// `no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key`.
//
// Suppressed lines must be reported; otherwise the unused-directive check
// fails. Unsuppressed examples define the allowed boundary.

const Panel = ({ key: _key }: { key?: string }) => <section />;
const workspaceId = "workspace";

export const _duplicateExpression = () => (
  <main>
    <Panel key={workspaceId} />
    {/* oxlint-disable-next-line no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key */}
    <Panel key={workspaceId} />
  </main>
);

export const _duplicateLiteral = () => (
  <>
    <Panel key="summary" />
    {/* oxlint-disable-next-line no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key */}
    <Panel key={"summary"} />
  </>
);

export const _distinctKeys = () => (
  <main>
    <Panel key={`case-law:${workspaceId}`} />
    {/* expect-clean: no-duplicate-jsx-sibling-key/no-duplicate-jsx-sibling-key */}
    <Panel key={`activity:${workspaceId}`} />
  </main>
);

export const _unkeyedStaticSiblings = () => (
  <main>
    <Panel />
    <Panel />
  </main>
);

export const _separateParentScopes = () => (
  <>
    <main>
      <Panel key={workspaceId} />
    </main>
    <aside>
      <Panel key={workspaceId} />
    </aside>
  </>
);
