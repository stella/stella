import {
  applyReplacements,
  directPropertyValue,
  rootObjectStart,
  stringTokenAt,
  type JsonTextReplacement,
} from "./json-text-edit";

type WorkspaceVersions = Readonly<Record<string, string>>;

const LABEL = "bun.lock";

/**
 * Updates only workspace self-versions in Bun's text lockfile.
 *
 * Bun does not refresh these cached values on an ordinary install. Recreating the
 * whole lockfile does, but also re-resolves unrelated dependency ranges. Walking
 * the JSON structure lets a release change exactly the intended version strings
 * while preserving every dependency resolution byte-for-byte.
 */
export const syncLockfileWorkspaceVersions = (
  lockText: string,
  workspaceVersions: WorkspaceVersions,
): string => {
  const rootStart = rootObjectStart(lockText, LABEL);
  const workspacesStart = directPropertyValue({
    label: LABEL,
    objectStart: rootStart,
    property: "workspaces",
    text: lockText,
  });
  if (lockText[workspacesStart] !== "{") {
    throw new TypeError("bun.lock workspaces property must be an object");
  }
  const replacements: JsonTextReplacement[] = Object.entries(
    workspaceVersions,
  ).map(([workspace, version]) => {
    const workspaceStart = directPropertyValue({
      label: LABEL,
      missingMessage: `bun.lock has no workspace entry for ${workspace}`,
      objectStart: workspacesStart,
      property: workspace,
      text: lockText,
    });
    if (lockText[workspaceStart] !== "{") {
      throw new TypeError(`bun.lock workspace ${workspace} must be an object`);
    }
    const versionStart = directPropertyValue({
      label: LABEL,
      objectStart: workspaceStart,
      property: "version",
      text: lockText,
    });
    const token = stringTokenAt(lockText, versionStart);
    return {
      end: token.end,
      start: token.start,
      value: JSON.stringify(version),
    };
  });

  return applyReplacements(lockText, replacements);
};
