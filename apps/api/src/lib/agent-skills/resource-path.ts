import { SKILL_RESOURCE_PATH_PATTERN } from "@stll/api-contract";
import { SKILL_PACKAGE_LIMITS } from "@stll/skills/format";

// Rules (the Agent Skills spec allows any folder and file name, so only what
// keeps a path safe to store, serve and unpack is refused):
//   - Relative: no leading slash, no empty, `.` or `..` segment.
//   - No control, format or line-separator characters, no backslash and none
//     of `< > : " | ? *` (Windows forbids them in file names).
//   - No segment starts or ends with whitespace or ends with a dot.
//
// `update.ts` only enforces a length cap; this helper is used by
// `create.ts` and `rename.ts`. The pattern is shared with the editor through
// @stll/api-contract and matches @stll/skills/format.
export const RESOURCE_PATH_PATTERN = SKILL_RESOURCE_PATH_PATTERN;
export const RESOURCE_PATH_MAX_CHARS =
  SKILL_PACKAGE_LIMITS.resourcePathMaxChars;
