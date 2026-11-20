import { Result } from "better-result";
import { expect, test } from "bun:test";

import { SKILL_PACKAGE_LIMITS } from "@stll/skills/format";

import { writeSkillPackageArchive } from "@/api/lib/agent-skills/skill-export";
import { parseUploadedSkillPackage } from "@/api/lib/skills/skill-package";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

/**
 * `length` ASCII characters from a fixed pseudo-random sequence over
 * base64 letters: deterministic, and too varied for DEFLATE to shrink much,
 * so the archive stays within the import's compression-ratio bound as a real
 * package does.
 */
const incompressibleText = (length: number): string => {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const codes = new Uint8Array(length);
  // Park-Miller minimal standard generator: plain arithmetic, fixed seed.
  let state = 20_261_120;
  for (let index = 0; index < length; index += 1) {
    state = (state * 48_271) % 2_147_483_647;
    codes[index] = alphabet.codePointAt(state % alphabet.length) ?? 65;
  }
  return new TextDecoder().decode(codes);
};

const SKILL_MD = [
  "---",
  'name: "contract-review"',
  'description: "Review a contract against the checklist."',
  "---",
  "",
  "Read `references/checklist.md` first.",
  "",
].join("\n");

test("a package whose files fill the package limit archives and imports whole", async () => {
  const encoder = new TextEncoder();
  const chunk = SKILL_PACKAGE_LIMITS.resourceMaxChars;
  const total = SKILL_PACKAGE_LIMITS.packageFilesMaxBytes;
  const checklist = encoder.encode("- parties\n");
  const text = encoder.encode(incompressibleText(chunk));
  const resources = [{ bytes: checklist, path: "references/checklist.md" }];
  const parts = total - checklist.byteLength;
  for (let offset = 0; offset < parts; offset += chunk) {
    resources.push({
      bytes: text.subarray(0, Math.min(chunk, parts - offset)),
      path: `references/part-${String(resources.length).padStart(2, "0")}.md`,
    });
  }

  const archive = await writeSkillPackageArchive({
    command: "review",
    displayName: "Contract review",
    resources,
    skillMd: SKILL_MD,
    slug: "contract-review",
  });
  const imported = await parseUploadedSkillPackage(
    testScannedFile({
      bytes: archive.slice().buffer,
      mimeType: "application/zip",
      path: "contract-review.skill",
    }),
  );

  if (Result.isError(imported)) {
    throw imported.error;
  }
  expect(imported.value.identity).toEqual({
    command: "review",
    displayName: "Contract review",
    slug: "contract-review",
  });
  expect(imported.value.resources.map(({ path }) => path)).toEqual(
    resources.map(({ path }) => path),
  );
  expect(
    imported.value.resources.reduce((sum, { sizeBytes }) => sum + sizeBytes, 0),
  ).toBe(total);
});
