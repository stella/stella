/**
 * Regenerate the signature stamp's fallback fonts in
 * `src/lib/files/pdf-signing/fonts/` from pinned Noto sources.
 *
 * The source fonts are 10 to 18 MB each; the committed files are subsets
 * built here, so the API image carries only what a stamp can draw:
 *
 * - Han, kana and CJK punctuation: the union of GB 2312, Big5 level 1,
 *   JIS X 0208 and the KS X 1001 hanja, from Noto Sans SC, without layout
 *   tables (CJK text draws one glyph per character).
 * - Hangul: the 2,350 KS X 1001 syllables and the compatibility jamo, from
 *   Noto Sans KR, likewise without layout tables.
 * - Devanagari and Thai: the whole font, layout tables kept, because both
 *   scripts need shaping.
 *
 * Variable sources are instanced at the regular weight and width, and
 * hinting is dropped. Every subset keeps printable ASCII so digits and
 * punctuation inside a run draw in the run's own face.
 *
 * Requires `hb-subset` (HarfBuzz 10 or later) on PATH.
 *
 * Usage:  bun run src/scripts/subset-stamp-fonts.ts
 */

import { panic, Result } from "better-result";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";

/** A google/fonts commit, so the bytes behind each URL cannot move. */
const SOURCE_COMMIT = "23e54b51ddffbc7713c583748e3bd86f62b1fa4a";
const SOURCE_BASE = `https://raw.githubusercontent.com/google/fonts/${SOURCE_COMMIT}/ofl`;

/** Noto Sans SC and KR ship the same licence text, so they share one file. */
const SOURCES = {
  sc: {
    font: "notosanssc/NotoSansSC%5Bwght%5D.ttf",
    fontSha256:
      "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
    licenseOutput: "NotoSansCJK-LICENSE.txt",
    license: "notosanssc/OFL.txt",
    licenseSha256:
      "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
  },
  kr: {
    font: "notosanskr/NotoSansKR%5Bwght%5D.ttf",
    fontSha256:
      "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252",
    licenseOutput: "NotoSansCJK-LICENSE.txt",
    license: "notosanskr/OFL.txt",
    licenseSha256:
      "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
  },
  devanagari: {
    font: "notosansdevanagari/NotoSansDevanagari%5Bwdth,wght%5D.ttf",
    fontSha256:
      "14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e",
    licenseOutput: "NotoSansDevanagari-LICENSE.txt",
    license: "notosansdevanagari/OFL.txt",
    licenseSha256:
      "a216f6f8d85c7228093e0ee5e258d9d377e6671f68acb4db1930b29583d0f331",
  },
  thai: {
    font: "notosansthai/NotoSansThai%5Bwdth,wght%5D.ttf",
    fontSha256:
      "5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8",
    licenseOutput: "NotoSansThai-LICENSE.txt",
    license: "notosansthai/OFL.txt",
    licenseSha256:
      "2e98fd23a52d253db8612cd5942c8f2ff4111b21d2367050fdca91d8ccc374a0",
  },
} as const;

type SourceKey = keyof typeof SOURCES;

const FONTS_DIR = path.join(import.meta.dir, "../lib/files/pdf-signing/fonts");
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

/** Tables a one-glyph-per-character script never reads. */
const CJK_DROPPED_TABLES = "GSUB,GPOS,GDEF,vhea,vmtx,VORG,BASE,DSIG,STAT";

const PRINTABLE_ASCII = "20-7e";

const sha256Hex = (bytes: ArrayBuffer) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const download = async ({
  permit,
  relative,
  sha256,
}: {
  permit: ThirdPartyOutboundPermit;
  relative: string;
  sha256: string;
}) => {
  const response = await safeOutboundFetchBytes({
    permit,
    maxBytes: DOWNLOAD_MAX_BYTES,
    redirect: "error",
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    url: `${SOURCE_BASE}/${relative}`,
  });
  if (Result.isError(response) || !response.value.ok) {
    return panic(
      `download of ${relative} failed: ${Result.isError(response) ? response.error.message : `HTTP ${response.value.status}`}`,
    );
  }
  const digest = sha256Hex(response.value.body);
  if (digest !== sha256) {
    return panic(`${relative} has digest ${digest}; pinned ${sha256}`);
  }
  return response.value.body;
};

/**
 * Every character a two-byte legacy set encodes, decoded through the
 * runtime's own tables: the set of characters that set's users write.
 */
const legacySet = (
  label: ConstructorParameters<typeof TextDecoder>[0],
  lead: readonly [number, number],
  trail: readonly [number, number],
) => {
  const decoder = new TextDecoder(label);
  const found = new Set<number>();
  for (let first = lead[0]; first <= lead[1]; first += 1) {
    for (let second = trail[0]; second <= trail[1]; second += 1) {
      const text = decoder.decode(new Uint8Array([first, second]));
      const codePoint = text.codePointAt(0);
      if (
        codePoint !== undefined &&
        Array.from(text).length === 1 &&
        codePoint !== 0xff_fd &&
        codePoint > 0x7f
      ) {
        found.add(codePoint);
      }
    }
  }
  return found;
};

const KS_X_1001 = legacySet("euc-kr", [0xa1, 0xfe], [0xa1, 0xfe]);
const isHangul = (codePoint: number) =>
  /\p{Script=Hangul}/u.test(String.fromCodePoint(codePoint));

/** CJK symbols and punctuation, kana, and half- and fullwidth forms. */
const CJK_RANGES = [
  [0x30_00, 0x30_3f],
  [0x30_40, 0x30_ff],
  [0x31_f0, 0x31_ff],
  [0xff_00, 0xff_ef],
] as const;

const cjkCodePoints = () => {
  const union = new Set<number>([
    ...legacySet("gbk", [0xa1, 0xf7], [0xa1, 0xfe]),
    ...legacySet("big5", [0xa1, 0xc6], [0x40, 0xfe]),
    ...legacySet("euc-jp", [0xa1, 0xf4], [0xa1, 0xfe]),
    ...[...KS_X_1001].filter((codePoint) => !isHangul(codePoint)),
  ]);
  for (const [from, to] of CJK_RANGES) {
    for (let codePoint = from; codePoint <= to; codePoint += 1) {
      union.add(codePoint);
    }
  }
  return union;
};

const hangulCodePoints = () =>
  new Set([...KS_X_1001].filter((codePoint) => isHangul(codePoint)));

const unicodesArgument = (codePoints: ReadonlySet<number>) =>
  [...codePoints]
    .toSorted((a, b) => a - b)
    .map((codePoint) => codePoint.toString(16))
    .join(",");

type Target = {
  output: string;
  source: SourceKey;
  /** hb-subset arguments beyond input, output and hinting. */
  arguments: readonly string[];
};

const targets = (workDir: string): readonly Target[] => [
  {
    output: "NotoSansSC-Subset.ttf",
    source: "sc",
    arguments: [
      "--variations=wght=400",
      `--unicodes-file=${path.join(workDir, "cjk.txt")}`,
      `--unicodes+=${PRINTABLE_ASCII}`,
      `--drop-tables+=${CJK_DROPPED_TABLES}`,
    ],
  },
  {
    output: "NotoSansKR-Subset.ttf",
    source: "kr",
    arguments: [
      "--variations=wght=400",
      `--unicodes-file=${path.join(workDir, "hangul.txt")}`,
      `--unicodes+=${PRINTABLE_ASCII}`,
      `--drop-tables+=${CJK_DROPPED_TABLES}`,
    ],
  },
  {
    output: "NotoSansDevanagari-Subset.ttf",
    source: "devanagari",
    arguments: ["--variations=wght=400 wdth=100", "--unicodes=*"],
  },
  {
    output: "NotoSansThai-Subset.ttf",
    source: "thai",
    arguments: ["--variations=wght=400 wdth=100", "--unicodes=*"],
  },
];

const workDir = await mkdtemp(path.join(tmpdir(), "stamp-fonts-"));
const permit = grantThirdPartyOutboundPermit();
try {
  await Bun.write(
    path.join(workDir, "cjk.txt"),
    unicodesArgument(cjkCodePoints()),
  );
  await Bun.write(
    path.join(workDir, "hangul.txt"),
    unicodesArgument(hangulCodePoints()),
  );
  for (const [key, source] of Object.entries(SOURCES)) {
    const [font, license] = await Promise.all([
      download({ permit, relative: source.font, sha256: source.fontSha256 }),
      download({
        permit,
        relative: source.license,
        sha256: source.licenseSha256,
      }),
    ]);
    await Bun.write(path.join(workDir, `${key}.ttf`), font);
    await Bun.write(path.join(FONTS_DIR, source.licenseOutput), license);
  }
  for (const target of targets(workDir)) {
    const outputPath = path.join(FONTS_DIR, target.output);
    const subset = Bun.spawnSync(
      [
        "hb-subset",
        path.join(workDir, `${target.source}.ttf`),
        "--no-hinting",
        ...target.arguments,
        `--output-file=${outputPath}`,
      ],
      { stderr: "pipe" },
    );
    if (subset.exitCode !== 0) {
      panic(`hb-subset ${target.output}: ${subset.stderr.toString()}`);
    }
    console.log(`${target.output}: ${Bun.file(outputPath).size} bytes`);
  }
} finally {
  await rm(workDir, { force: true, recursive: true });
}
