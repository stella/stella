// Source: https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
export const GITLEAKS_VERSION = "8.30.1";
export const GITLEAKS_SHA256 = {
  "linux-x64":
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  "linux-arm64":
    "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  "darwin-x64":
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  "darwin-arm64":
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
} as const satisfies Record<`${"linux" | "darwin"}-${"x64" | "arm64"}`, string>;

// SHA-256 of the `gitleaks` member inside each archive above, taken from the
// archives after they matched GITLEAKS_SHA256. An executable with these bytes
// is the pinned release, wherever an installer placed it.
export const GITLEAKS_BINARY_SHA256 = {
  "linux-x64":
    "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
  "linux-arm64":
    "00e91bbe655bd7c47753e8cfe61cb76ea1a5d7e7702fe161ee40102b46b3823b",
  "darwin-x64":
    "cee01fea7173f1b779dff188e1c26ecbcb4027d394acc573b23aaf0be260e291",
  "darwin-arm64":
    "ba52fb1bfabbcde42f032afad3d6e0b19dff8ed105229a16e7caa338bbc0e84f",
} as const satisfies Record<keyof typeof GITLEAKS_SHA256, string>;
