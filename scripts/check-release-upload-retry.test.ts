import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const WORKFLOWS_URL = new URL("../.github/workflows/", import.meta.url);
const UPLOAD_COMMAND = "gh release upload";
/** Tolerates a checkout-path prefix, as in `.workflow-source/scripts/…`. */
const WRAPPED_UPLOAD =
  /\bbash\s+(?:[\w.\-/]+\/)?scripts\/retry\.sh\s+gh\s+release\s+upload\b/u;
/**
 * A transient GitHub 5xx once left a release with half its assets. Fewer sites
 * than this means the scan stopped finding them, not that they stopped existing.
 */
const MINIMUM_UPLOAD_SITES = 4;

type UploadSite = {
  file: string;
  line: number;
  text: string;
};

const collectUploadSites = async (): Promise<UploadSite[]> => {
  const workflows = [
    ...new Bun.Glob("*.yml").scanSync({
      cwd: fileURLToPath(WORKFLOWS_URL),
    }),
  ].toSorted();
  const sites: UploadSite[] = [];

  for (const file of workflows) {
    const contents = await Bun.file(new URL(file, WORKFLOWS_URL)).text();
    const lines = contents.split("\n");

    for (const [index, line] of lines.entries()) {
      // A comment naming the command documents a permission, it does not run it.
      if (!line.includes(UPLOAD_COMMAND) || line.trimStart().startsWith("#")) {
        continue;
      }
      sites.push({ file, line: index + 1, text: line.trim() });
    }
  }

  return sites;
};

describe("release asset uploads", () => {
  test("every gh release upload retries", async () => {
    const sites = await collectUploadSites();

    expect(sites.length).toBeGreaterThanOrEqual(MINIMUM_UPLOAD_SITES);

    const bare = sites.filter(({ text }) => !WRAPPED_UPLOAD.test(text));
    const report = bare
      .map(
        ({ file, line, text }) =>
          `.github/workflows/${file}:${line}: ${text}\n` +
          `    wrap it: bash scripts/retry.sh ${UPLOAD_COMMAND} …`,
      )
      .join("\n");

    expect(report).toBe("");
  });
});
