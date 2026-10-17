import path from "node:path";

import { collectFailureTags, renderFailureTags } from "./failure-tags";
import {
  formattedLikeRepository,
  writeOrCheckArtifacts,
} from "./generated-artifacts";

const root = path.join(import.meta.dirname, "..");
process.exitCode = await writeOrCheckArtifacts(
  [
    {
      path: path.join(
        root,
        "apps/api/src/lib/observability/failure-tags.gen.ts",
      ),
      contents: await formattedLikeRepository(
        renderFailureTags(await collectFailureTags(root)),
        ".ts",
      ),
    },
  ],
  {
    write: process.argv.includes("--write"),
    matched: "production TaggedError declarations",
  },
);
