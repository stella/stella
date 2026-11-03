// `xcode` ships no types, and `expo/config-plugins` types its Xcode project
// helpers with it. These name what this app's config plugins read; the rest
// stays opaque.
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
  }
}
