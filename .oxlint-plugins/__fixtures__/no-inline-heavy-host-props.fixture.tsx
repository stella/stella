type ViewerProps = { display: { id: string } };

const FileTabViewer = (_props: ViewerProps) => null;
const SmallViewer = (_props: ViewerProps) => null;

const stable = { id: "field-1" };

export const HeavyHosts = () => (
  <>
    {/* oxlint-disable-next-line no-inline-heavy-host-props/no-inline-heavy-host-props -- fixture: inline heavy-host input must be rejected */}
    <FileTabViewer display={{ id: "field-1" }} />
  </>
);

// expect-clean: no-inline-heavy-host-props/no-inline-heavy-host-props
export const CleanHosts = () => (
  <>
    <FileTabViewer display={stable} />
    <SmallViewer display={{ id: "field-1" }} />
  </>
);
