declare module "electrobun" {
  type BuildTargetConfig = {
    bundleCEF?: boolean;
  };

  type MacBuildTargetConfig = BuildTargetConfig & {
    icons?: string;
  };

  type WinBuildTargetConfig = BuildTargetConfig & {
    icon?: string;
  };

  export type ElectrobunConfig = {
    app?: {
      identifier?: string;
      name?: string;
      urlSchemes?: string[];
      version?: string;
    };
    build?: {
      copy?: Record<string, string>;
      linux?: BuildTargetConfig;
      mac?: MacBuildTargetConfig;
      watchIgnore?: string[];
      win?: WinBuildTargetConfig;
    };
    release?: {
      baseUrl?: string;
      generatePatch?: boolean;
    };
    runtime?: {
      exitOnLastWindowClosed?: boolean;
    };
  };
}
