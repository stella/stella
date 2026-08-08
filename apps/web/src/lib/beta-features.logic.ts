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
