import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { DesktopRunnerAttachment } from "@stll/api-contract/desktop-runner";
import type { Fetcher } from "@stll/fetch";

import { copyAttachments } from "./attachments";
import {
  MAX_INPUT_FILES,
  MAX_INPUT_IMAGE_BYTES,
  MAX_INPUT_PDF_PAGES,
  MAX_INPUT_TURN_BYTES,
  readInputFiles,
} from "./input-files";

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** An uncompressed PDF with `pages` pages, as simple writers produce it. */
const pdf = (pages: number, extra = "") => {
  const kids = Array.from(
    { length: pages },
    (_, index) => `${String(index + 3)} 0 R`,
  ).join(" ");
  const pageObjects = Array.from(
    { length: pages },
    (_, index) =>
      `${String(index + 3)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n`,
  ).join("");
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${String(pages)} >>\nendobj\n${pageObjects}${extra}trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
};

const answering =
  (bodies: ReadonlyMap<string, Uint8Array>): Fetcher =>
  async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return await Promise.resolve(
      new Response(bodies.get(url) ?? new Uint8Array(), { status: 200 }),
    );
  };

const fileId = (index: number) =>
  `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`;

describe("handing a turn's attached files to the model", () => {
  let root = "";
  let workspace = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "input-files-root-"));
    workspace = path.join(root, "workspace");
    await mkdir(workspace);
    outside = await mkdtemp(path.join(tmpdir(), "input-files-outside-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  /** Copies the files the way a run does, then reads what the turn names. */
  const copied = async (
    files: readonly { name: string; bytes: Uint8Array }[],
  ) => {
    const bodies = new Map<string, Uint8Array>();
    const attachments: DesktopRunnerAttachment[] = files.map(
      ({ name, bytes }, index) => {
        const url = `https://files.example/${String(index)}`;
        bodies.set(url, bytes);
        return { path: `attachments/${fileId(index)}/${name}`, url };
      },
    );
    const copy = await copyAttachments(attachments, workspace, {
      fetch: answering(bodies),
    });
    expect(Result.isOk(copy)).toBe(true);
    return attachments;
  };

  const naming = (attachments: readonly DesktopRunnerAttachment[]) => ({
    role: "user" as const,
    content: [
      { type: "text" as const, content: "What do these show?" },
      ...attachments.map(({ path: at }) => ({
        type: "text" as const,
        content: `Attached file is in your folder at ${at}.`,
      })),
    ],
  });

  test("an image and a PDF the message names reach the model, in its order", async () => {
    const attachments = await copied([
      { name: "plan.png", bytes: PNG },
      { name: "smlouva o dílo.pdf", bytes: pdf(2) },
    ]);
    const read = await readInputFiles({
      attachments: attachments.toReversed(),
      workspaceDir: workspace,
      request: naming(attachments),
      accepts: ["image", "pdf"],
    });
    expect(read).toEqual({
      files: [
        {
          type: "image",
          mediaType: "image/png",
          base64: PNG.toString("base64"),
        },
        { type: "pdf", base64: pdf(2).toString("base64") },
      ],
      skipped: [],
    });
  });

  test("the type comes from the file's bytes, never from its name", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const gif = Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1");
    const webp = Buffer.from("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ", "latin1");
    const attachments = await copied([
      { name: "photo.png", bytes: jpeg },
      { name: "a.gif", bytes: gif },
      { name: "b", bytes: webp },
      { name: "fake.png", bytes: Buffer.from("not an image") },
      { name: "notes.docx", bytes: Buffer.from("PK\u0003\u0004") },
    ]);
    const read = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: naming(attachments),
      accepts: ["image", "pdf"],
    });
    expect(
      read.files.map((file) => file.type === "image" && file.mediaType),
    ).toEqual(["image/jpeg", "image/gif", "image/webp"]);
    expect(read.skipped).toEqual(["unsupported_type", "unsupported_type"]);
  });

  test("only what the turn's message names goes; earlier turns' files stay in the folder", async () => {
    const attachments = await copied([
      { name: "earlier.png", bytes: PNG },
      { name: "now.png", bytes: PNG },
    ]);
    const read = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: naming(attachments.slice(1)),
      accepts: ["image"],
    });
    expect(read.files).toHaveLength(1);
    expect(read.skipped).toEqual([]);
    const none = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: { role: "assistant", content: attachments[0]?.path ?? "" },
      accepts: ["image"],
    });
    expect(none).toEqual({ files: [], skipped: [] });
  });

  test("a harness that reads no PDF keeps it a path", async () => {
    const attachments = await copied([
      { name: "a.pdf", bytes: pdf(1) },
      { name: "a.png", bytes: PNG },
    ]);
    const read = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: naming(attachments),
      accepts: ["image"],
    });
    expect(read.files.map(({ type }) => type)).toEqual(["image"]);
    expect(read.skipped).toEqual(["not_accepted"]);
  });

  test("an oversized image, a PDF whose pages cannot be counted, and a turn over its limits stay paths", async () => {
    const oversized = Buffer.concat([
      PNG,
      Buffer.alloc(MAX_INPUT_IMAGE_BYTES - PNG.length + 1),
    ]);
    const attachments = await copied([
      { name: "huge.png", bytes: oversized },
      {
        name: "packed.pdf",
        bytes: pdf(1, "4 0 obj\n<< /Type /ObjStm /N 3 >>\nendobj\n"),
      },
      { name: "long.pdf", bytes: pdf(MAX_INPUT_PDF_PAGES + 1) },
    ]);
    const read = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: naming(attachments),
      accepts: ["image", "pdf"],
    });
    expect(read).toEqual({
      files: [],
      skipped: ["too_large", "pdf_pages_unknown", "turn_full"],
    });
  });

  test("a turn takes files up to its byte and count limits, then keeps the rest paths", async () => {
    const nearlyFull = Buffer.concat([
      PNG,
      Buffer.alloc(MAX_INPUT_IMAGE_BYTES - PNG.length),
    ]);
    const big = await copied(
      Array.from({ length: 3 }, (_, index) => ({
        name: `big-${String(index)}.png`,
        bytes: nearlyFull,
      })),
    );
    const bytes = await readInputFiles({
      attachments: big,
      workspaceDir: workspace,
      request: naming(big),
      accepts: ["image"],
    });
    expect(bytes.files).toHaveLength(
      Math.floor(MAX_INPUT_TURN_BYTES / nearlyFull.length),
    );
    expect(bytes.skipped).toEqual(["turn_full"]);

    await rm(path.join(workspace, "attachments"), { recursive: true });
    const many = await copied(
      Array.from({ length: MAX_INPUT_FILES + 1 }, (_, index) => ({
        name: `${String(index)}.png`,
        bytes: PNG,
      })),
    );
    const count = await readInputFiles({
      attachments: many,
      workspaceDir: workspace,
      request: naming(many),
      accepts: ["image"],
    });
    expect(count.files).toHaveLength(MAX_INPUT_FILES);
    expect(count.skipped).toEqual(["turn_full"]);
  });

  test("a link the agent planted, at the file or a folder on the way, is never followed", async () => {
    const secret = path.join(outside, "secret.png");
    await writeFile(secret, PNG);
    const atFile = `attachments/${fileId(1)}/plan.png`;
    await mkdir(path.join(workspace, path.dirname(atFile)), {
      recursive: true,
    });
    await symlink(secret, path.join(workspace, atFile));
    const atFolder = `attachments/${fileId(2)}/plan.png`;
    await symlink(outside, path.join(workspace, path.dirname(atFolder)));
    await writeFile(path.join(outside, "plan.png"), PNG);
    const attachments = [
      { path: atFile, url: "https://files.example/1" },
      { path: atFolder, url: "https://files.example/2" },
    ];
    const read = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: naming(attachments),
      accepts: ["image"],
    });
    expect(read).toEqual({ files: [], skipped: ["link", "link"] });
  });

  test("a FIFO or a folder at the file's place is not read, and does not wait", async () => {
    const atFifo = `attachments/${fileId(1)}/plan.png`;
    await mkdir(path.join(workspace, path.dirname(atFifo)), {
      recursive: true,
    });
    const made = Bun.spawnSync(["mkfifo", path.join(workspace, atFifo)]);
    expect(made.exitCode).toBe(0);
    const atFolder = `attachments/${fileId(2)}/plan.png`;
    await mkdir(path.join(workspace, atFolder), { recursive: true });
    const missing = `attachments/${fileId(3)}/gone.png`;
    const attachments = [atFifo, atFolder, missing].map((at) => ({
      path: at,
      url: "https://files.example/x",
    }));
    const read = await readInputFiles({
      attachments,
      workspaceDir: workspace,
      request: naming(attachments),
      accepts: ["image"],
    });
    expect(read).toEqual({
      files: [],
      skipped: ["not_a_file", "not_a_file", "unreadable"],
    });
  });
});
