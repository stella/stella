import {
  createDocx,
  createEmptyDocument,
  createStellaStyleDocumentPreset,
  extractDocumentStyleSet,
  FolioDocxReviewer,
} from "@stll/folio-core/server";
import type { DocumentPreset, DocumentStyleSet } from "@stll/folio-core/server";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { StyleSetEditorSettings } from "@/api/lib/style-set-editor-contract";

const TWIPS_PER_POINT = 20;
const HALF_POINTS_PER_POINT = 2;
const SINGLE_LINE_TWIPS = 240;
const DEFAULT_FONT_FAMILY = "Arial";
const DEFAULT_FONT_SIZE_PT = 10;
const DEFAULT_MARGIN_PT = 72;
const EDITOR_NUMBERING_NAME = "Stella editor legal numbering";
const EDITOR_NUMBERING_STYLE_ID = "StellaStyleEditorNumbering";
const EDITOR_NUMBERING_STYLE_NAME = "Stella Style editor numbering metadata";
const ROLE_STYLE_IDS = {
  title: ["Title"],
  level1: ["ClauseHeading1", "Heading1"],
  level2: ["ClauseParagraph1", "Heading2"],
  level3: ["ClauseParagraph2", "Heading3"],
} as const;
const CREATED_ROLE_STYLE_IDS = {
  title: "Title",
  level1: "Heading1",
  level2: "Heading2",
  level3: "Heading3",
} as const;
const PAPER_SIZES_TWIPS = {
  a4: { width: 11_906, height: 16_838 },
  letter: { width: 12_240, height: 15_840 },
  legal: { width: 12_240, height: 20_160 },
} as const;
const PAPER_SIZE_TOLERANCE_TWIPS = 12;

type StyleDefinition = DocumentStyleSet["styles"]["styles"][number];
type ParagraphFormatting = NonNullable<StyleDefinition["pPr"]>;
type TextFormatting = NonNullable<StyleDefinition["rPr"]>;
type SectionProperties = DocumentPreset["sectionProperties"];
type NumberingFormat = StyleSetEditorSettings["level1"]["numberingFormat"];
type Alignment = StyleSetEditorSettings["body"]["alignment"];

type EditablePreset = {
  preset: DocumentPreset;
  settings: StyleSetEditorSettings;
};

export const createStellaStyleEditorPreset = (): EditablePreset => {
  const preset = createStellaStyleDocumentPreset();
  return { preset, settings: projectStyleSetEditorSettings(preset) };
};

export const readStyleSetEditorPreset = async (
  buffer: Buffer,
  name: string,
): Promise<EditablePreset> => {
  const reviewer = await FolioDocxReviewer.fromBuffer(toArrayBuffer(buffer));
  const document = reviewer.toDocument();
  const firstParagraph = document.package.document.content.find(
    (block) => block.type === "paragraph",
  );
  const initialParagraphStyleId = firstParagraph?.formatting?.styleId;
  const styleSet = extractDocumentStyleSet(
    document,
    initialParagraphStyleId ? { name, initialParagraphStyleId } : { name },
  );
  const sectionProperties =
    document.package.document.finalSectionProperties ??
    document.package.document.sections?.at(0)?.properties ??
    createStellaStyleDocumentPreset().sectionProperties;
  const preset = {
    version: 1,
    name,
    styleSet,
    sectionProperties,
  } satisfies DocumentPreset;

  return { preset, settings: projectStyleSetEditorSettings(preset) };
};

export const applyStyleSetEditorSettings = (
  source: DocumentPreset,
  name: string,
  settings: StyleSetEditorSettings,
): DocumentPreset => {
  const preset = structuredClone(source);
  preset.name = name;
  preset.styleSet.name = name;

  const roles = ensureRoleStyles(preset.styleSet);
  applyBodySettings(preset.styleSet, roles.body, settings);
  applyParagraphStyleSettings(roles.title, settings.title);
  applyParagraphStyleSettings(roles.level1, settings.level1);
  applyParagraphStyleSettings(roles.level2, settings.level2);
  applyParagraphStyleSettings(roles.level3, settings.level3);
  for (const fontName of [
    settings.body.fontFamily,
    settings.title.fontFamily,
    settings.level1.fontFamily,
    settings.level2.fontFamily,
    settings.level3.fontFamily,
  ]) {
    ensureFontTableEntry(preset.styleSet, fontName);
  }
  applyNumberingSettings(preset.styleSet, roles, settings);
  applyPageSettings(preset.sectionProperties, settings.page);

  return preset;
};

export const createStyleSetEditorBuffer = async (
  source: DocumentPreset,
  name: string,
  settings: StyleSetEditorSettings,
): Promise<Buffer> =>
  Buffer.from(
    new Uint8Array(
      await createDocx(
        createEmptyDocument({
          preset: applyStyleSetEditorSettings(source, name, settings),
        }),
      ),
    ),
  );

const projectStyleSetEditorSettings = (
  preset: DocumentPreset,
): StyleSetEditorSettings => {
  const roles = ensureRoleStyles(preset.styleSet);
  const bodyFormatting = resolveStyleFormatting(preset.styleSet, roles.body);
  const titleFormatting = resolveStyleFormatting(preset.styleSet, roles.title);
  const level1Formatting = resolveStyleFormatting(
    preset.styleSet,
    roles.level1,
  );
  const level2Formatting = resolveStyleFormatting(
    preset.styleSet,
    roles.level2,
  );
  const level3Formatting = resolveStyleFormatting(
    preset.styleSet,
    roles.level3,
  );
  const numbering = findNumberingLevels(preset.styleSet, roles);

  return {
    body: {
      fontFamily: fontFamily(bodyFormatting.rPr),
      fontSizePt: fontSizePt(bodyFormatting.rPr),
      alignment: alignment(bodyFormatting.pPr.alignment),
      lineSpacing: lineSpacing(bodyFormatting.pPr),
      spaceAfterPt: fromTwips(bodyFormatting.pPr.spaceAfter ?? 0),
    },
    title: paragraphStyleSettings(titleFormatting),
    level1: numberedParagraphStyleSettings(
      level1Formatting,
      numbering.level1,
      1,
    ),
    level2: numberedParagraphStyleSettings(
      level2Formatting,
      numbering.level2,
      2,
    ),
    level3: numberedParagraphStyleSettings(
      level3Formatting,
      numbering.level3,
      3,
    ),
    numbering: { enabled: numbering.enabled },
    page: projectPageSettings(preset.sectionProperties),
  };
};

type RoleStyles = {
  body: StyleDefinition;
  title: StyleDefinition;
  level1: StyleDefinition;
  level2: StyleDefinition;
  level3: StyleDefinition;
};

const ensureRoleStyles = (styleSet: DocumentStyleSet): RoleStyles => {
  const body = findBodyStyle(styleSet);
  return {
    body,
    title: findOrCreateRoleStyle(styleSet, "title", body.styleId),
    level1: findOrCreateRoleStyle(styleSet, "level1", body.styleId),
    level2: findOrCreateRoleStyle(styleSet, "level2", body.styleId),
    level3: findOrCreateRoleStyle(styleSet, "level3", body.styleId),
  };
};

const findBodyStyle = (styleSet: DocumentStyleSet): StyleDefinition => {
  const styles = styleSet.styles.styles;
  const initial = styles.find(
    (style) =>
      style.type === "paragraph" &&
      style.styleId === styleSet.initialParagraphStyleId,
  );
  if (initial) {
    return initial;
  }
  const defaultParagraph = styles.find(
    (style) => style.type === "paragraph" && style.default,
  );
  if (defaultParagraph) {
    styleSet.initialParagraphStyleId = defaultParagraph.styleId;
    return defaultParagraph;
  }

  const body = {
    styleId: "BodyText",
    type: "paragraph",
    name: "Body Text",
    default: true,
    qFormat: true,
  } satisfies StyleDefinition;
  styles.push(body);
  styleSet.initialParagraphStyleId = body.styleId;
  return body;
};

type Role = keyof typeof ROLE_STYLE_IDS;

const findOrCreateRoleStyle = (
  styleSet: DocumentStyleSet,
  role: Role,
  bodyStyleId: string,
): StyleDefinition => {
  const styles = styleSet.styles.styles;
  for (const styleId of ROLE_STYLE_IDS[role]) {
    const style = styles.find(
      (candidate) =>
        candidate.type === "paragraph" && candidate.styleId === styleId,
    );
    if (style) {
      return style;
    }
  }

  const outlineLevels = {
    title: null,
    level1: 0,
    level2: 1,
    level3: 2,
  } as const satisfies Record<Role, number | null>;
  const outlineLevel = outlineLevels[role];
  if (outlineLevel !== null) {
    const outlined = styles.find(
      (style) =>
        style.type === "paragraph" && style.pPr?.outlineLevel === outlineLevel,
    );
    if (outlined) {
      return outlined;
    }
  }

  const styleId = CREATED_ROLE_STYLE_IDS[role];
  const headingNumbers = {
    level1: 1,
    level2: 2,
    level3: 3,
  } as const;
  const name = role === "title" ? "Title" : `Heading ${headingNumbers[role]}`;
  const style = {
    styleId,
    type: "paragraph",
    name,
    basedOn: bodyStyleId,
    next: bodyStyleId,
    qFormat: true,
    pPr:
      outlineLevel === null
        ? { keepNext: true }
        : { keepNext: true, outlineLevel },
  } satisfies StyleDefinition;
  styles.push(style);
  return style;
};

type ResolvedStyleFormatting = {
  pPr: ParagraphFormatting;
  rPr: TextFormatting;
};

const resolveStyleFormatting = (
  styleSet: DocumentStyleSet,
  target: StyleDefinition,
): ResolvedStyleFormatting => {
  const stylesById = new Map(
    styleSet.styles.styles.map((style) => [style.styleId, style]),
  );
  const chain: StyleDefinition[] = [];
  const visited = new Set<string>();
  let current: StyleDefinition | undefined = target;
  while (current && !visited.has(current.styleId)) {
    visited.add(current.styleId);
    chain.unshift(current);
    current = current.basedOn ? stylesById.get(current.basedOn) : undefined;
  }

  const pPr: ParagraphFormatting = {
    ...styleSet.styles.docDefaults?.pPr,
  };
  let rPr: TextFormatting = mergeTextFormatting(
    {},
    styleSet.styles.docDefaults?.rPr,
  );
  for (const style of chain) {
    Object.assign(pPr, style.pPr);
    rPr = mergeTextFormatting(rPr, style.rPr);
  }
  return { pPr, rPr };
};

const mergeTextFormatting = (
  base: TextFormatting,
  override: TextFormatting | undefined,
): TextFormatting => {
  const merged = { ...base, ...override };
  if (base.fontFamily || override?.fontFamily) {
    merged.fontFamily = { ...base.fontFamily, ...override?.fontFamily };
  }
  return merged;
};

const fontFamily = (formatting: TextFormatting): string =>
  formatting.fontFamily?.ascii ??
  formatting.fontFamily?.hAnsi ??
  formatting.fontFamily?.cs ??
  DEFAULT_FONT_FAMILY;

const fontSizePt = (formatting: TextFormatting): number =>
  (formatting.fontSize ?? formatting.fontSizeCs ?? DEFAULT_FONT_SIZE_PT * 2) /
  HALF_POINTS_PER_POINT;

const alignment = (value: ParagraphFormatting["alignment"]): Alignment => {
  if (
    value === "left" ||
    value === "center" ||
    value === "right" ||
    value === "both"
  ) {
    return value;
  }
  return "preserve";
};

const lineSpacing = (
  formatting: ParagraphFormatting,
): StyleSetEditorSettings["body"]["lineSpacing"] => {
  if (
    formatting.lineSpacingRule !== undefined &&
    formatting.lineSpacingRule !== "auto"
  ) {
    return "preserve";
  }
  const value = formatting.lineSpacing ?? SINGLE_LINE_TWIPS;
  if (Math.abs(value - SINGLE_LINE_TWIPS) <= 2) {
    return "single";
  }
  if (Math.abs(value - SINGLE_LINE_TWIPS * 1.15) <= 2) {
    return "onePoint15";
  }
  if (Math.abs(value - SINGLE_LINE_TWIPS * 1.5) <= 2) {
    return "onePoint5";
  }
  if (Math.abs(value - SINGLE_LINE_TWIPS * 2) <= 2) {
    return "double";
  }
  return "preserve";
};

const paragraphStyleSettings = ({
  pPr,
  rPr,
}: ResolvedStyleFormatting): StyleSetEditorSettings["title"] => ({
  fontFamily: fontFamily(rPr),
  fontSizePt: fontSizePt(rPr),
  bold: rPr.bold ?? false,
  alignment: alignment(pPr.alignment),
  spaceBeforePt: fromTwips(pPr.spaceBefore ?? 0),
  spaceAfterPt: fromTwips(pPr.spaceAfter ?? 0),
});

type NumberingLevel = NonNullable<
  DocumentStyleSet["numbering"]
>["abstractNums"][number]["levels"][number];

const numberedParagraphStyleSettings = (
  formatting: ResolvedStyleFormatting,
  numberingLevel: NumberingLevel | undefined,
  level: 1 | 2 | 3,
): StyleSetEditorSettings["level1"] => {
  const indentFirstLine = numberingLevel?.pPr?.indentFirstLine ?? 0;
  return {
    ...paragraphStyleSettings(formatting),
    numberingFormat: numberingFormat(numberingLevel, level),
    indentLeftPt: fromTwips(numberingLevel?.pPr?.indentLeft ?? 0),
    hangingPt: fromTwips(Math.max(0, -indentFirstLine)),
  };
};

const numberingFormat = (
  level: NumberingLevel | undefined,
  displayLevel: 1 | 2 | 3,
): NumberingFormat => {
  if (!level) {
    if (displayLevel === 1) {
      return "decimal";
    }
    if (displayLevel === 2) {
      return "hierarchicalDecimal";
    }
    return "lowerLetterParenthetical";
  }
  if (level.numFmt === "decimal" && level.lvlText === `%${displayLevel}`) {
    return "decimal";
  }
  const hierarchical = Array.from(
    { length: displayLevel },
    (_, index) => `%${index + 1}`,
  ).join(".");
  if (level.numFmt === "decimal" && level.lvlText === hierarchical) {
    return "hierarchicalDecimal";
  }
  if (
    level.numFmt === "lowerLetter" &&
    level.lvlText === `(%${displayLevel})`
  ) {
    return "lowerLetterParenthetical";
  }
  if (level.numFmt === "lowerRoman" && level.lvlText === `(%${displayLevel})`) {
    return "lowerRomanParenthetical";
  }
  if (
    level.numFmt === "upperLetter" &&
    level.lvlText === `(%${displayLevel})`
  ) {
    return "upperLetterParenthetical";
  }
  if (level.numFmt === "upperRoman" && level.lvlText === `%${displayLevel}`) {
    return "upperRoman";
  }
  return "preserve";
};

type NumberingLevels = {
  enabled: boolean;
  level1?: NumberingLevel | undefined;
  level2?: NumberingLevel | undefined;
  level3?: NumberingLevel | undefined;
};

const findNumberingLevels = (
  styleSet: DocumentStyleSet,
  roles: RoleStyles,
): NumberingLevels => {
  const definitions = styleSet.numbering;
  const level1NumId = roles.level1.pPr?.numPr?.numId;
  if (!definitions) {
    return { enabled: false };
  }
  if (level1NumId === undefined) {
    const preserved = definitions.abstractNums.findLast(
      (candidate) => candidate.name === EDITOR_NUMBERING_NAME,
    );
    return {
      enabled: false,
      level1: preserved?.levels.find((level) => level.ilvl === 0),
      level2: preserved?.levels.find((level) => level.ilvl === 1),
      level3: preserved?.levels.find((level) => level.ilvl === 2),
    };
  }
  const instance = definitions.nums.find((num) => num.numId === level1NumId);
  const abstract = definitions.abstractNums.find(
    (candidate) => candidate.abstractNumId === instance?.abstractNumId,
  );
  if (!abstract) {
    return { enabled: false };
  }
  return {
    enabled: true,
    level1: abstract.levels.find((level) => level.ilvl === 0),
    level2: abstract.levels.find((level) => level.ilvl === 1),
    level3: abstract.levels.find((level) => level.ilvl === 2),
  };
};

const applyBodySettings = (
  styleSet: DocumentStyleSet,
  body: StyleDefinition,
  settings: StyleSetEditorSettings,
) => {
  const font = textFormatting(
    settings.body.fontFamily,
    settings.body.fontSizePt,
  );
  styleSet.styles.docDefaults = {
    ...styleSet.styles.docDefaults,
    rPr: {
      ...styleSet.styles.docDefaults?.rPr,
      ...font,
    },
  };
  body.rPr = { ...body.rPr, ...font };
  body.pPr = {
    ...body.pPr,
    spaceAfter: toTwips(settings.body.spaceAfterPt),
  };
  applyAlignment(body.pPr, settings.body.alignment);
  applyLineSpacing(body.pPr, settings.body.lineSpacing);
};

const applyParagraphStyleSettings = (
  style: StyleDefinition,
  settings: StyleSetEditorSettings["title"],
) => {
  style.rPr = {
    ...style.rPr,
    ...textFormatting(settings.fontFamily, settings.fontSizePt),
    bold: settings.bold,
  };
  style.pPr = {
    ...style.pPr,
    spaceBefore: toTwips(settings.spaceBeforePt),
    spaceAfter: toTwips(settings.spaceAfterPt),
  };
  applyAlignment(style.pPr, settings.alignment);
};

const textFormatting = (family: string, sizePt: number): TextFormatting => ({
  fontFamily: { ascii: family, hAnsi: family, cs: family },
  fontSize: sizePt * HALF_POINTS_PER_POINT,
  fontSizeCs: sizePt * HALF_POINTS_PER_POINT,
});

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const applyAlignment = (formatting: ParagraphFormatting, value: Alignment) => {
  if (value !== "preserve") {
    formatting.alignment = value;
  }
};

const applyLineSpacing = (
  formatting: ParagraphFormatting,
  value: StyleSetEditorSettings["body"]["lineSpacing"],
) => {
  if (value === "preserve") {
    return;
  }
  const multipliers = {
    single: 1,
    onePoint15: 1.15,
    onePoint5: 1.5,
    double: 2,
  } as const;
  const multiplier = multipliers[value];
  formatting.lineSpacing = Math.round(SINGLE_LINE_TWIPS * multiplier);
  formatting.lineSpacingRule = "auto";
};

const ensureFontTableEntry = (styleSet: DocumentStyleSet, fontName: string) => {
  styleSet.fontTable ??= { fonts: [] };
  const hasFont = styleSet.fontTable.fonts.some(
    (font) => font.name.toLowerCase() === fontName.toLowerCase(),
  );
  if (!hasFont) {
    styleSet.fontTable.fonts.push({ name: fontName });
  }
};

const applyNumberingSettings = (
  styleSet: DocumentStyleSet,
  roles: RoleStyles,
  settings: StyleSetEditorSettings,
) => {
  if (!settings.numbering.enabled) {
    preserveEditorNumberingDefinition(styleSet, roles);
    for (const style of [roles.level1, roles.level2, roles.level3]) {
      if (style.pPr) {
        delete style.pPr.numPr;
      }
    }
    return;
  }

  styleSet.numbering ??= { abstractNums: [], nums: [] };
  const existing = findNumberingLevels(styleSet, roles);
  const currentNumId = roles.level1.pPr?.numPr?.numId;
  const currentInstance = styleSet.numbering.nums.find(
    (num) => num.numId === currentNumId,
  );
  const abstract = currentInstance
    ? styleSet.numbering.abstractNums.find(
        (candidate) =>
          candidate.abstractNumId === currentInstance.abstractNumId,
      )
    : styleSet.numbering.abstractNums.findLast(
        (candidate) => candidate.name === EDITOR_NUMBERING_NAME,
      );
  const activeAbstract =
    abstract ?? createEditorNumberingDefinition(styleSet.numbering);
  const activeNumId =
    currentInstance?.numId ??
    styleSet.numbering.nums.find(
      (num) => num.abstractNumId === activeAbstract.abstractNumId,
    )?.numId;
  if (activeNumId === undefined) {
    return;
  }

  const levelSettings = [
    settings.level1,
    settings.level2,
    settings.level3,
  ] as const;
  const existingLevels = [
    existing.level1,
    existing.level2,
    existing.level3,
  ] as const;
  for (const [index, levelSettingsValue] of levelSettings.entries()) {
    const level = ensureNumberingLevel(
      activeAbstract,
      index,
      existingLevels[index],
    );
    applyNumberingFormat(level, levelSettingsValue.numberingFormat, index + 1);
    const authoredFirstLineIndent = level.pPr?.indentFirstLine ?? 0;
    const indentFirstLine =
      levelSettingsValue.hangingPt > 0
        ? -toTwips(levelSettingsValue.hangingPt)
        : Math.max(0, authoredFirstLineIndent);
    level.pPr = {
      ...level.pPr,
      indentLeft: toTwips(levelSettingsValue.indentLeftPt),
      indentFirstLine,
      hangingIndent: indentFirstLine < 0,
    };
  }

  for (const [index, style] of [
    roles.level1,
    roles.level2,
    roles.level3,
  ].entries()) {
    style.pPr = {
      ...style.pPr,
      numPr: { numId: activeNumId, ilvl: index },
    };
  }
};

type NumberingDefinitions = NonNullable<DocumentStyleSet["numbering"]>;
type AbstractNumbering = NumberingDefinitions["abstractNums"][number];

const preserveEditorNumberingDefinition = (
  styleSet: DocumentStyleSet,
  roles: RoleStyles,
) => {
  const numbering = styleSet.numbering;
  const currentNumId = roles.level1.pPr?.numPr?.numId;
  if (!numbering || currentNumId === undefined) {
    return;
  }
  const currentInstance = numbering.nums.find(
    (candidate) => candidate.numId === currentNumId,
  );
  const currentAbstract = numbering.abstractNums.find(
    (candidate) => candidate.abstractNumId === currentInstance?.abstractNumId,
  );
  if (!currentAbstract || currentAbstract.name === EDITOR_NUMBERING_NAME) {
    if (currentAbstract) {
      ensureEditorNumberingMarkerStyle(styleSet, currentNumId);
    }
    return;
  }

  const preserved = createEditorNumberingDefinition(numbering);
  if (currentAbstract.multiLevelType === undefined) {
    delete preserved.multiLevelType;
  } else {
    preserved.multiLevelType = currentAbstract.multiLevelType;
  }
  preserved.levels = structuredClone(currentAbstract.levels);
  const preservedNumId = numbering.nums.find(
    (candidate) => candidate.abstractNumId === preserved.abstractNumId,
  )?.numId;
  if (preservedNumId !== undefined) {
    ensureEditorNumberingMarkerStyle(styleSet, preservedNumId);
  }
};

const ensureEditorNumberingMarkerStyle = (
  styleSet: DocumentStyleSet,
  numId: number,
) => {
  const styles = styleSet.styles.styles;
  const existing = styles.find(
    (style) =>
      style.name === EDITOR_NUMBERING_STYLE_NAME && style.hidden === true,
  );
  if (existing) {
    existing.pPr = { ...existing.pPr, numPr: { numId, ilvl: 0 } };
    return;
  }
  let styleId = EDITOR_NUMBERING_STYLE_ID;
  let suffix = 1;
  while (styles.some((style) => style.styleId === styleId)) {
    styleId = `${EDITOR_NUMBERING_STYLE_ID}${suffix}`;
    suffix += 1;
  }
  styles.push({
    styleId,
    type: "paragraph",
    name: EDITOR_NUMBERING_STYLE_NAME,
    hidden: true,
    semiHidden: true,
    pPr: { numPr: { numId, ilvl: 0 } },
  });
};

const createEditorNumberingDefinition = (
  numbering: NumberingDefinitions,
): AbstractNumbering => {
  const abstractNumId =
    Math.max(-1, ...numbering.abstractNums.map((item) => item.abstractNumId)) +
    1;
  const numId = Math.max(0, ...numbering.nums.map((item) => item.numId)) + 1;
  const abstract = {
    abstractNumId,
    multiLevelType: "multilevel",
    name: EDITOR_NUMBERING_NAME,
    levels: [],
  } satisfies AbstractNumbering;
  numbering.abstractNums.push(abstract);
  numbering.nums.push({ numId, abstractNumId });
  return abstract;
};

const ensureNumberingLevel = (
  abstract: AbstractNumbering,
  ilvl: number,
  fallback: NumberingLevel | undefined,
): NumberingLevel => {
  const existing = abstract.levels.find((level) => level.ilvl === ilvl);
  if (existing) {
    return existing;
  }
  const level = fallback
    ? { ...structuredClone(fallback), ilvl }
    : {
        ilvl,
        start: 1,
        numFmt: "decimal" as const,
        lvlText: `%${ilvl + 1}`,
        suffix: "tab" as const,
      };
  abstract.levels.push(level);
  abstract.levels.sort((left, right) => left.ilvl - right.ilvl);
  return level;
};

const applyNumberingFormat = (
  level: NumberingLevel,
  format: NumberingFormat,
  displayLevel: number,
) => {
  if (format === "preserve") {
    return;
  }
  if (format === "hierarchicalDecimal") {
    level.numFmt = "decimal";
    level.lvlText = Array.from(
      { length: displayLevel },
      (_, index) => `%${index + 1}`,
    ).join(".");
    level.isLgl = true;
    return;
  }

  const formatValues = {
    decimal: { numFmt: "decimal", parenthetical: false },
    lowerLetterParenthetical: {
      numFmt: "lowerLetter",
      parenthetical: true,
    },
    lowerRomanParenthetical: {
      numFmt: "lowerRoman",
      parenthetical: true,
    },
    upperLetterParenthetical: {
      numFmt: "upperLetter",
      parenthetical: true,
    },
    upperRoman: { numFmt: "upperRoman", parenthetical: false },
  } as const;
  const selected = formatValues[format];
  level.numFmt = selected.numFmt;
  level.lvlText = selected.parenthetical
    ? `(%${displayLevel})`
    : `%${displayLevel}`;
  if (format === "decimal") {
    level.isLgl = true;
  } else {
    delete level.isLgl;
  }
};

const projectPageSettings = (
  section: SectionProperties,
): StyleSetEditorSettings["page"] => {
  const orientation = section.orientation ?? "portrait";
  const width = section.pageWidth ?? PAPER_SIZES_TWIPS.a4.width;
  const height = section.pageHeight ?? PAPER_SIZES_TWIPS.a4.height;
  const portraitWidth = orientation === "landscape" ? height : width;
  const portraitHeight = orientation === "landscape" ? width : height;
  const paperSize = findPaperSize(portraitWidth, portraitHeight);

  return {
    paperSize,
    orientation,
    marginTopPt: fromTwips(section.marginTop ?? toTwips(DEFAULT_MARGIN_PT)),
    marginBottomPt: fromTwips(
      section.marginBottom ?? toTwips(DEFAULT_MARGIN_PT),
    ),
    marginLeftPt: fromTwips(section.marginLeft ?? toTwips(DEFAULT_MARGIN_PT)),
    marginRightPt: fromTwips(section.marginRight ?? toTwips(DEFAULT_MARGIN_PT)),
  };
};

const findPaperSize = (
  width: number,
  height: number,
): StyleSetEditorSettings["page"]["paperSize"] => {
  for (const [name, dimensions] of Object.entries(PAPER_SIZES_TWIPS)) {
    if (
      Math.abs(width - dimensions.width) <= PAPER_SIZE_TOLERANCE_TWIPS &&
      Math.abs(height - dimensions.height) <= PAPER_SIZE_TOLERANCE_TWIPS &&
      (name === "a4" || name === "letter" || name === "legal")
    ) {
      return name;
    }
  }
  return "preserve";
};

const applyPageSettings = (
  section: SectionProperties,
  page: StyleSetEditorSettings["page"],
) => {
  const currentOrientation = section.orientation ?? "portrait";
  let finalWidth = section.pageWidth ?? PAPER_SIZES_TWIPS.a4.width;
  let finalHeight = section.pageHeight ?? PAPER_SIZES_TWIPS.a4.height;
  if (page.paperSize !== "preserve") {
    const dimensions = PAPER_SIZES_TWIPS[page.paperSize];
    finalWidth =
      page.orientation === "portrait" ? dimensions.width : dimensions.height;
    finalHeight =
      page.orientation === "portrait" ? dimensions.height : dimensions.width;
  } else if (currentOrientation !== page.orientation) {
    [finalWidth, finalHeight] = [finalHeight, finalWidth];
  }

  const horizontalMargins =
    toTwips(page.marginLeftPt) + toTwips(page.marginRightPt);
  const verticalMargins =
    toTwips(page.marginTopPt) + toTwips(page.marginBottomPt);
  if (horizontalMargins >= finalWidth || verticalMargins >= finalHeight) {
    throw new HandlerError({
      status: 400,
      message: "Page margins must leave a printable area.",
    });
  }

  if (page.paperSize !== "preserve") {
    section.pageWidth = finalWidth;
    section.pageHeight = finalHeight;
  } else if (
    currentOrientation !== page.orientation &&
    section.pageWidth !== undefined &&
    section.pageHeight !== undefined
  ) {
    const previousWidth = section.pageWidth;
    section.pageWidth = section.pageHeight;
    section.pageHeight = previousWidth;
  }
  section.orientation = page.orientation;
  section.marginTop = toTwips(page.marginTopPt);
  section.marginBottom = toTwips(page.marginBottomPt);
  section.marginLeft = toTwips(page.marginLeftPt);
  section.marginRight = toTwips(page.marginRightPt);
};

const toTwips = (points: number): number =>
  Math.round(points * TWIPS_PER_POINT);

const fromTwips = (twips: number): number =>
  Math.round((twips / TWIPS_PER_POINT) * 100) / 100;
