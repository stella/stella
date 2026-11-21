// `xcode` ships no types, and `expo/config-plugins` types its Xcode project
// helpers with it. These name what this app's config plugins read and call;
// the rest stays opaque.
declare module "xcode" {
  export type UUID = string;

  export type XCBuildConfiguration = {
    name: string;
    buildSettings: Record<string, string | undefined>;
  };

  export type PBXNativeTarget = {
    name: string;
    buildConfigurationList: UUID;
  };

  export type PBXFile = Record<string, unknown>;
  export type PBXGroup = Record<string, unknown>;
  export type PBXProject = Record<string, unknown>;
  export type XCConfigurationList = Record<string, unknown>;

  export class XcodeProject {
    private constructor();

    /** The parsed project; `objects` holds each section by its isa. */
    hash: {
      project: {
        objects: Record<string, Record<string, unknown> | undefined>;
      };
    };

    getFirstProject(): { firstProject: { mainGroup: UUID } };

    /** A group of `files`, each referenced by its name under `path`. */
    addPbxGroup(
      files: readonly string[],
      name: string,
      path: string,
    ): { uuid: UUID };

    addToPbxGroup(group: UUID, parent: UUID): void;

    /**
     * A native target with Debug and Release configurations; an app
     * extension is also embedded in the first target and made its dependency.
     */
    addTarget(
      name: string,
      type: "app_extension",
      subfolder: string,
      bundleId: string,
    ): { uuid: UUID; pbxNativeTarget: PBXNativeTarget };

    addBuildPhase(
      files: readonly string[],
      type:
        | "PBXSourcesBuildPhase"
        | "PBXResourcesBuildPhase"
        | "PBXFrameworksBuildPhase",
      comment: string,
      target: UUID,
    ): unknown;
  }
}
