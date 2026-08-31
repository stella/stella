type PreviewRouteAvailability = {
  browserPreviewEnabled: boolean;
  deploymentEnabled: boolean;
  hostDefaultEnabled: boolean;
};

export const previewRouteAvailable = ({
  browserPreviewEnabled,
  deploymentEnabled,
  hostDefaultEnabled,
}: PreviewRouteAvailability): boolean =>
  deploymentEnabled || hostDefaultEnabled || browserPreviewEnabled;

type PublicShellPreviewEntry = {
  browserPreviewEnabled: boolean;
  deploymentEnabled: boolean;
  mounted: boolean;
};

// A preview entry in server-rendered chrome. The server cannot read a
// per-browser toggle, so neither may the first client render: until the shell
// mounts only the deployment override counts, and an opted-in browser picks
// the entry up on the render after that.
export const publicShellPreviewEntryVisible = ({
  browserPreviewEnabled,
  deploymentEnabled,
  mounted,
}: PublicShellPreviewEntry): boolean =>
  mounted ? browserPreviewEnabled : deploymentEnabled;
