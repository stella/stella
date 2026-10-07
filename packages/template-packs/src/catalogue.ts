import { Result, TaggedError } from "better-result";
/**
 * Loader over a generated pack manifest. The manifest is committed data; the
 * DOCX bytes stay in the content tree and are read by path, so a checkout
 * without the content submodule still imports this module and simply serves
 * an empty catalogue.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { GENERATED_TEMPLATE_PACKS } from "./packs.gen";
import type {
  GeneratedTemplatePack,
  GeneratedTemplatePackTemplate,
} from "./schema";

export type TemplatePackDocx = {
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, lowercase hex; equals the manifest hash. */
  sha256: string;
  fileName: string;
};

/** The bytes on disk do not match the hash recorded at generation time. */
export class TemplatePackContentError extends TaggedError(
  "TemplatePackContentError",
)<{
  message: string;
  packId: string;
  slug: string;
}> {}

export type TemplatePackTemplateRef = {
  packId: string;
  slug: string;
};

export type TemplatePackCatalogue = {
  list: () => readonly GeneratedTemplatePack[];
  get: (packId: string) => GeneratedTemplatePack | null;
  getTemplate: (
    ref: TemplatePackTemplateRef,
  ) => GeneratedTemplatePackTemplate | null;
  readTemplateDocx: (
    ref: TemplatePackTemplateRef,
  ) => Promise<Result<TemplatePackDocx, TemplatePackContentError>>;
};

/** Content directory of a source checkout: the submodule mount point. */
export const bundledTemplatePackContentRoot = (): string =>
  path.join(import.meta.dir, "..", "content");

const PACKS_DIRECTORY = "packs";

export type CreateTemplatePackCatalogueOptions = {
  packs: readonly GeneratedTemplatePack[];
  /**
   * Directory holding `packs/<id>/…`. A root that does not carry that
   * directory means the content is not present in this checkout or image,
   * and the catalogue is empty rather than advertising packs it cannot read.
   */
  contentRoot: string;
  /** Public entries require readable, nonempty regular files. */
  availability?: "exists" | "readable";
};

/**
 * Build a catalogue over a manifest and the content root its paths resolve
 * against. Tests bind the same factory to the fixture manifest and fixture
 * content instead of mocking modules.
 */
export const createTemplatePackCatalogue = ({
  packs,
  contentRoot,
  availability = "exists",
}: CreateTemplatePackCatalogueOptions): TemplatePackCatalogue => {
  const available = packs.filter(
    (pack) =>
      pack.templates.length > 0 &&
      pack.templates.every((template) => {
        const docxPath = path.join(
          contentRoot,
          PACKS_DIRECTORY,
          pack.id,
          template.file,
        );
        if (availability === "exists") {
          return existsSync(docxPath);
        }
        // Metadata and byte reads can both fail on inaccessible content.
        return Result.try(() => {
          const file = statSync(docxPath, { throwIfNoEntry: false });
          return (
            file !== undefined &&
            file.isFile() &&
            file.size > 0 &&
            readFileSync(docxPath).byteLength > 0
          );
        }).unwrapOr(false);
      }),
  );
  const packsById = new Map(available.map((pack) => [pack.id, pack] as const));

  const get = (packId: string) => packsById.get(packId) ?? null;

  const getTemplate = ({ packId, slug }: TemplatePackTemplateRef) =>
    get(packId)?.templates.find((template) => template.slug === slug) ?? null;

  const readTemplateDocx = async (
    ref: TemplatePackTemplateRef,
  ): Promise<Result<TemplatePackDocx, TemplatePackContentError>> => {
    const template = getTemplate(ref);
    if (!template) {
      return Result.err(
        new TemplatePackContentError({
          message: "Template not found in pack",
          packId: ref.packId,
          slug: ref.slug,
        }),
      );
    }
    // `file` is a validated relative path, so this stays under the root.
    const docxPath = path.join(
      contentRoot,
      PACKS_DIRECTORY,
      ref.packId,
      template.file,
    );
    const read = await Result.tryPromise({
      try: async () => new Uint8Array(await Bun.file(docxPath).arrayBuffer()),
      catch: () =>
        new TemplatePackContentError({
          message: "Bundled template content is unavailable",
          packId: ref.packId,
          slug: ref.slug,
        }),
    });
    if (Result.isError(read)) {
      return read;
    }
    const bytes = read.value;
    const sha256 = hashSha256Hex(bytes);
    if (sha256 !== template.sha256) {
      return Result.err(
        new TemplatePackContentError({
          message: "Bundled template bytes do not match the manifest hash",
          packId: ref.packId,
          slug: ref.slug,
        }),
      );
    }
    return Result.ok({
      bytes,
      sha256,
      fileName: `${template.slug}.docx`,
    });
  };

  return { list: () => available, get, getTemplate, readTemplateDocx };
};

/** Catalogue over the content bundled with this build. */
export const createBundledTemplatePackCatalogue = (
  contentRoot: string = bundledTemplatePackContentRoot(),
  {
    availability = "exists",
  }: Pick<CreateTemplatePackCatalogueOptions, "availability"> = {},
): TemplatePackCatalogue =>
  createTemplatePackCatalogue({
    packs: GENERATED_TEMPLATE_PACKS,
    contentRoot,
    availability,
  });
