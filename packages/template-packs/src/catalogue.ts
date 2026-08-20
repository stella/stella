/**
 * Loader over a generated pack manifest. The manifest is committed data; the
 * DOCX bytes stay in the content tree and are read by path, so a checkout
 * without the content submodule still imports this module and simply serves
 * an empty catalogue.
 */

import { Result, TaggedError } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

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

const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export type CreateTemplatePackCatalogueOptions = {
  packs: readonly GeneratedTemplatePack[];
  /**
   * Directory holding `packs/<id>/…`. A root that does not carry that
   * directory means the content is not present in this checkout or image,
   * and the catalogue is empty rather than advertising packs it cannot read.
   */
  contentRoot: string;
};

/**
 * Build a catalogue over a manifest and the content root its paths resolve
 * against. Tests bind the same factory to the fixture manifest and fixture
 * content instead of mocking modules.
 */
export const createTemplatePackCatalogue = ({
  packs,
  contentRoot,
}: CreateTemplatePackCatalogueOptions): TemplatePackCatalogue => {
  const available = existsSync(path.join(contentRoot, PACKS_DIRECTORY))
    ? packs
    : [];
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
    const file = Bun.file(docxPath);
    if (!(await file.exists())) {
      return Result.err(
        new TemplatePackContentError({
          message: "Bundled template content is missing",
          packId: ref.packId,
          slug: ref.slug,
        }),
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = sha256Hex(bytes);
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
): TemplatePackCatalogue =>
  createTemplatePackCatalogue({
    packs: GENERATED_TEMPLATE_PACKS,
    contentRoot,
  });
