import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_DOWNLOAD_STAGING_FOLDER,
  type BrowserDownload,
} from "@stll/api-contract/browser-control";

import {
  BROWSER_DOWNLOADS_FOLDER,
  downloadFileStem,
  receiveBrowserDownload,
} from "./downloads";

const PDF = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n";
const SOURCE_URL = "https://fixture-library.test/doc/1/file";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

/** Chrome's download folder with its staging folder, and a run's folder. */
const folders = () => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-browser-downloads-"));
  roots.push(root);
  const chromeDownloads = path.join(root, "chrome-downloads");
  const staging = path.join(chromeDownloads, BROWSER_DOWNLOAD_STAGING_FOLDER);
  const workspaceDir = path.join(root, "chat");
  mkdirSync(staging, { recursive: true });
  mkdirSync(workspaceDir);
  /** A file Chrome saved under a staged name; its path. */
  const stage = (content: string | null) => {
    const staged = path.join(staging, `${crypto.randomUUID()}.pdf`);
    if (content !== null) {
      writeFileSync(staged, content);
    }
    return staged;
  };
  return { chromeDownloads, root, stage, staging, workspaceDir };
};

const saved = (
  file: string,
  suggestedName = "Decision 1.pdf",
): BrowserDownload => ({
  bytes: 0,
  mime: "application/pdf",
  outcome: "saved",
  path: file,
  sourceUrl: SOURCE_URL,
  suggestedName,
});

const savedFiles = (workspaceDir: string) =>
  existsSync(path.join(workspaceDir, BROWSER_DOWNLOADS_FOLDER))
    ? readdirSync(path.join(workspaceDir, BROWSER_DOWNLOADS_FOLDER)).toSorted()
    : [];

describe("a PDF a chat's tab downloaded", () => {
  test("is copied into the run's downloads folder and leaves the staging folder", async () => {
    const { stage, workspaceDir } = folders();
    const staged = stage(PDF);

    const outcome = await receiveBrowserDownload(saved(staged), workspaceDir);

    expect(outcome).toEqual({
      bytes: Buffer.byteLength(PDF),
      path: "Downloads/Decision 1.pdf",
      sourceUrl: SOURCE_URL,
      status: "saved",
    });
    expect(
      readFileSync(path.join(workspaceDir, "Downloads", "Decision 1.pdf"), {
        encoding: "utf-8",
      }),
    ).toBe(PDF);
    expect(existsSync(staged)).toBe(false);
  });

  test("never replaces a file already there: each name collision takes the next suffix", async () => {
    const { stage, workspaceDir } = folders();
    const downloads = path.join(workspaceDir, BROWSER_DOWNLOADS_FOLDER);
    mkdirSync(downloads);
    writeFileSync(path.join(downloads, "Decision 1.pdf"), "the member's notes");

    const second = await receiveBrowserDownload(
      saved(stage(PDF)),
      workspaceDir,
    );
    const third = await receiveBrowserDownload(saved(stage(PDF)), workspaceDir);

    expect([second, third].map((outcome) => outcome.status)).toEqual([
      "saved",
      "saved",
    ]);
    expect(savedFiles(workspaceDir)).toEqual([
      "Decision 1 (2).pdf",
      "Decision 1 (3).pdf",
      "Decision 1.pdf",
    ]);
    expect(readFileSync(path.join(downloads, "Decision 1.pdf"), "utf-8")).toBe(
      "the member's notes",
    );
  });

  test("a suggested name never steers the file outside the downloads folder", async () => {
    const { root, stage, workspaceDir } = folders();
    for (const suggested of [
      "../../escaped.pdf",
      "..\\..\\escaped.pdf",
      `${root}/escaped.pdf`,
      "..",
      ".hidden.pdf",
    ]) {
      // await-in-loop: one name at a time, so the outcomes stay apart.
      const outcome = await receiveBrowserDownload(
        saved(stage(PDF), suggested),
        workspaceDir,
      );
      expect(outcome.status).toBe("saved");
    }

    expect(savedFiles(workspaceDir)).toEqual([
      "download.pdf",
      "escaped (2).pdf",
      "escaped (3).pdf",
      "escaped.pdf",
      "hidden.pdf",
    ]);
    expect(existsSync(path.join(root, "escaped.pdf"))).toBe(false);
    expect(readdirSync(workspaceDir)).toEqual([BROWSER_DOWNLOADS_FOLDER]);
  });

  test("a downloads folder that is a link is refused and the file stays staged", async () => {
    const { root, stage, workspaceDir } = folders();
    const elsewhere = path.join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, path.join(workspaceDir, BROWSER_DOWNLOADS_FOLDER));
    const staged = stage(PDF);

    const outcome = await receiveBrowserDownload(saved(staged), workspaceDir);

    expect(outcome).toMatchObject({
      reason: "folder_unavailable",
      status: "refused",
    });
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(staged)).toBe(true);
  });
});

describe("a download that is not what it says", () => {
  test("bytes that are not a PDF's are refused, and the file this download created is removed", async () => {
    const { stage, workspaceDir } = folders();
    // Named and typed as a PDF; the bytes say otherwise.
    const staged = stage("<html><body>Not a PDF</body></html>");

    const outcome = await receiveBrowserDownload(saved(staged), workspaceDir);

    expect(outcome).toEqual({
      message: "The download is not a PDF; only PDFs are saved.",
      reason: "not_pdf",
      sourceUrl: SOURCE_URL,
      status: "refused",
    });
    expect(existsSync(staged)).toBe(false);
    expect(savedFiles(workspaceDir)).toEqual([]);
  });

  test("a file over the size limit is refused and removed", async () => {
    const { stage, workspaceDir } = folders();
    const staged = stage(PDF);
    // Sparse: no disk is used for the size.
    truncateSync(staged, BROWSER_CONTROL_LIMITS.downloadBytes + 1);

    const outcome = await receiveBrowserDownload(saved(staged), workspaceDir);

    expect(outcome).toMatchObject({ reason: "too_large", status: "refused" });
    expect(existsSync(staged)).toBe(false);
    expect(savedFiles(workspaceDir)).toEqual([]);
  });

  test("a link in place of the file is refused, and neither it nor its target is touched", async () => {
    const { root, staging, workspaceDir } = folders();
    const target = path.join(root, "member-file.pdf");
    writeFileSync(target, PDF);
    const staged = path.join(staging, `${crypto.randomUUID()}.pdf`);
    symlinkSync(target, staged);

    const outcome = await receiveBrowserDownload(saved(staged), workspaceDir);

    expect(outcome).toMatchObject({ reason: "link", status: "refused" });
    expect(lstatSync(staged).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(PDF);
    expect(savedFiles(workspaceDir)).toEqual([]);
  });

  test("a staging folder that is a link is refused", async () => {
    const { root, workspaceDir } = folders();
    const real = path.join(root, "real");
    mkdirSync(real);
    const linkedDownloads = path.join(root, "linked-downloads");
    mkdirSync(linkedDownloads);
    symlinkSync(
      real,
      path.join(linkedDownloads, BROWSER_DOWNLOAD_STAGING_FOLDER),
    );
    const name = `${crypto.randomUUID()}.pdf`;
    writeFileSync(path.join(real, name), PDF);

    const outcome = await receiveBrowserDownload(
      saved(path.join(linkedDownloads, BROWSER_DOWNLOAD_STAGING_FOLDER, name)),
      workspaceDir,
    );

    expect(outcome).toMatchObject({ reason: "not_staged", status: "refused" });
    expect(existsSync(path.join(real, name))).toBe(true);
  });

  test("a file outside the staging folder, or not under a staged name, is left where it is", async () => {
    const { chromeDownloads, staging, workspaceDir } = folders();
    const loose = path.join(chromeDownloads, "Decision 1.pdf");
    writeFileSync(loose, PDF);
    const misnamed = path.join(staging, "Decision 1.pdf");
    writeFileSync(misnamed, PDF);
    const stagedName = `${crypto.randomUUID()}.pdf`;

    for (const reported of [
      loose,
      misnamed,
      // Not a normal path: it climbs out and back in.
      `${staging}/../${BROWSER_DOWNLOAD_STAGING_FOLDER}/${stagedName}`,
      // Not absolute.
      `${BROWSER_DOWNLOAD_STAGING_FOLDER}/${stagedName}`,
    ]) {
      // await-in-loop: each report is judged on its own.
      const outcome = await receiveBrowserDownload(
        saved(reported),
        workspaceDir,
      );
      expect(outcome).toMatchObject({
        reason: "not_staged",
        status: "refused",
      });
    }
    expect(readFileSync(loose, "utf-8")).toBe(PDF);
    expect(readFileSync(misnamed, "utf-8")).toBe(PDF);
  });

  test("a file gone before it was checked is reported as vanished", async () => {
    const { stage, workspaceDir } = folders();

    const outcome = await receiveBrowserDownload(
      saved(stage(null)),
      workspaceDir,
    );

    expect(outcome).toMatchObject({ reason: "vanished", status: "refused" });
  });

  test("a folder in place of the file is refused and left alone", async () => {
    const { staging, workspaceDir } = folders();
    const staged = path.join(staging, `${crypto.randomUUID()}.pdf`);
    mkdirSync(staged);

    const outcome = await receiveBrowserDownload(saved(staged), workspaceDir);

    expect(outcome).toMatchObject({ reason: "not_a_file", status: "refused" });
    expect(lstatSync(staged).isDirectory()).toBe(true);
  });

  test("a download the extension stopped comes back with its reason", async () => {
    const { workspaceDir } = folders();
    const cases = [
      ["not-pdf", "not_pdf"],
      ["too-large", "too_large"],
      ["too-many", "too_many"],
      ["interrupted", "interrupted"],
    ] as const;
    for (const [reason, refusal] of cases) {
      // await-in-loop: each reason is judged on its own.
      const outcome = await receiveBrowserDownload(
        {
          outcome: "stopped",
          reason,
          sourceUrl: SOURCE_URL,
          suggestedName: "setup.dmg",
        },
        workspaceDir,
      );
      expect(outcome).toMatchObject({ reason: refusal, status: "refused" });
    }
    expect(savedFiles(workspaceDir)).toEqual([]);
  });
});

describe("the name a download is saved under", () => {
  test("keeps the page's name as a PDF's, without characters that disguise or break it", () => {
    expect(downloadFileStem("Decision 1.pdf")).toBe("Decision 1");
    expect(downloadFileStem("Decision 1.PDF")).toBe("Decision 1");
    expect(downloadFileStem("order.exe")).toBe("order.exe");
    // A right-to-left override would make the name read as ending in `.pdf`.
    expect(downloadFileStem("report\u202Efdp.exe")).toBe("reportfdp.exe");
    expect(downloadFileStem("a\u0000b\nc\td.pdf")).toBe("ab c d");
    expect(downloadFileStem('what: "is" <this>?.pdf')).toBe(
      "what_ _is_ _this__",
    );
    expect(downloadFileStem("  ...trailing. .pdf")).toBe("trailing");
    expect(downloadFileStem("")).toBe("download");
    expect(downloadFileStem("folder/")).toBe("download");
  });

  test("is bounded in bytes without splitting a character", () => {
    const stem = downloadFileStem(`${"č".repeat(300)}.pdf`);
    expect(Buffer.byteLength(stem)).toBeLessThanOrEqual(200);
    expect(stem).toBe("č".repeat(100));
  });
});
