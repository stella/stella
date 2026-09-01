export const resolveWorkspaceInspectorPresentation = ({
  hasMobilePresentation,
  isCompact,
}: {
  hasMobilePresentation: boolean;
  isCompact: boolean;
}): "desktop" | "mobile" =>
  hasMobilePresentation && isCompact ? "mobile" : "desktop";
