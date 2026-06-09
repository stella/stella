/**
 * Field Parser - Parse field codes in DOCX documents
 *
 * OOXML supports two types of fields:
 * 1. Simple fields (w:fldSimple) - Single element with instruction attribute
 * 2. Complex fields (w:fldChar + w:instrText) - Multi-element spanning runs
 *
 * Fields provide dynamic content like:
 * - Page numbers (PAGE, NUMPAGES)
 * - Dates and times (DATE, TIME, CREATEDATE)
 * - Document properties (AUTHOR, TITLE, FILENAME)
 * - Cross-references (REF, PAGEREF, NOTEREF)
 * - Tables of contents (TOC, INDEX)
 * - Mail merge fields (MERGEFIELD)
 *
 * OOXML Reference:
 * - Simple field: <w:fldSimple w:instr="FIELD INSTRUCTION">content</w:fldSimple>
 * - Complex field:
 *   <w:r><w:fldChar w:fldCharType="begin"/></w:r>
 *   <w:r><w:instrText>FIELD INSTRUCTION</w:instrText></w:r>
 *   <w:r><w:fldChar w:fldCharType="separate"/></w:r>
 *   <w:r><w:t>display result</w:t></w:r>
 *   <w:r><w:fldChar w:fldCharType="end"/></w:r>
 */

import type {
  FieldType,
  SimpleField,
  ComplexField,
  Field,
  Run,
  TextContent,
  Theme,
} from "../types/document";
import { FieldTypeSchema, narrowEnum } from "./parserEnums";
import { parseRun } from "./runParser";
import type { StyleMap } from "./styleParser";
import { getAttribute, findChildren } from "./xmlParser";
import type { XmlElement } from "./xmlParser";

// ============================================================================
// FIELD TYPE DETECTION
// ============================================================================

/**
 * All known field types from OOXML specification
 */
export const KNOWN_FIELD_TYPES: readonly FieldType[] = [
  // Document information
  "PAGE",
  "NUMPAGES",
  "NUMWORDS",
  "NUMCHARS",
  // Date and time
  "DATE",
  "TIME",
  "CREATEDATE",
  "SAVEDATE",
  "PRINTDATE",
  "EDITTIME",
  // Document properties
  "AUTHOR",
  "TITLE",
  "SUBJECT",
  "KEYWORDS",
  "COMMENTS",
  "FILENAME",
  "FILESIZE",
  "TEMPLATE",
  "REVNUM",
  "DOCPROPERTY",
  "DOCVARIABLE",
  // Cross-references
  "REF",
  "PAGEREF",
  "NOTEREF",
  "HYPERLINK",
  // Tables of contents and indexes
  "TOC",
  "TOA",
  "INDEX",
  // Numbering
  "SEQ",
  "STYLEREF",
  "AUTONUM",
  "AUTONUMLGL",
  "AUTONUMOUT",
  "LISTNUM",
  // Section info
  "SECTION",
  "SECTIONPAGES",
  // User info
  "USERADDRESS",
  "USERNAME",
  "USERINITIALS",
  // Mail merge
  "IF",
  "MERGEFIELD",
  "NEXT",
  "NEXTIF",
  "ASK",
  "SET",
  // Inclusion
  "QUOTE",
  "INCLUDETEXT",
  "INCLUDEPICTURE",
  // Other
  "SYMBOL",
  "ADVANCE",
];

/**
 * Parse field type from instruction string
 *
 * Field instructions follow the format: FIELDNAME [arguments] [switches]
 * Examples:
 * - "PAGE \\* MERGEFORMAT"
 * - "DATE \\@ \"MMMM d, yyyy\""
 * - "MERGEFIELD client_name \\* Upper"
 * - "REF _Ref123456 \\h"
 *
 * @param instruction - The field instruction string
 * @returns The detected field type
 */
export function parseFieldType(instruction: string): FieldType {
  if (!instruction) {
    return "UNKNOWN";
  }

  // Trim and extract the field name (first word, may have leading backslash)
  const trimmed = instruction.trim();
  const match = /^\\?([A-Z][A-Z0-9]*)/iu.exec(trimmed);

  if (!match) {
    return "UNKNOWN";
  }

  // SAFETY: match succeeded and group 1 always captures in this regex
  const fieldName = match[1]!.toUpperCase();
  return narrowEnum(fieldName, FieldTypeSchema) ?? "UNKNOWN";
}

/**
 * Check if a field type is a known type. The sentinel "UNKNOWN" value
 * is not considered a "known" type even though it belongs to FieldType.
 *
 * @param type - Field type string to check
 * @returns true if it's a known field type
 */
export function isKnownFieldType(type: string): type is FieldType {
  const narrowed = narrowEnum(type, FieldTypeSchema);
  return narrowed !== undefined && narrowed !== "UNKNOWN";
}

// ============================================================================
// FIELD INSTRUCTION PARSING
// ============================================================================

/**
 * Parsed field instruction with arguments and switches
 */
export type ParsedFieldInstruction = {
  /** Field type */
  type: FieldType;
  /** Raw instruction string */
  raw: string;
  /** Field argument (e.g., property name for DOCPROPERTY, bookmark name for REF) */
  argument?: string;
  /** Field switches (e.g., \* MERGEFORMAT, \@ "date format") */
  switches: FieldSwitch[];
};

/**
 * Field switch parsed from instruction
 */
export type FieldSwitch = {
  /** Switch character (e.g., '*', '@', '#', 'h', 'p') */
  switch: string;
  /** Switch value if any */
  value?: string;
};

/**
 * Parse a complete field instruction into structured data
 *
 * @param instruction - Raw instruction string
 * @returns Parsed instruction object
 */
export function parseFieldInstruction(
  instruction: string,
): ParsedFieldInstruction {
  const type = parseFieldType(instruction);
  const trimmed = instruction.trim();
  const switches: FieldSwitch[] = [];

  // Extract the field name part
  const nameMatch = /^\\?([A-Z][A-Z0-9]*)/iu.exec(trimmed);
  const fieldNameEnd = nameMatch ? nameMatch[0].length : 0;

  // Everything after the field name
  const remaining = trimmed.slice(fieldNameEnd).trim();

  // Extract switches (start with \)
  const switchRegex = /\\(\*|@|#|!|[a-z])\s*(?:"([^"]*)"|([\S]*))?/giu;
  let switchMatch;
  const switchPositions: { start: number; end: number }[] = [];

  while ((switchMatch = switchRegex.exec(remaining)) !== null) {
    const sw: FieldSwitch = {
      // SAFETY: group 1 always captures in this regex pattern
      switch: switchMatch[1]!,
    };

    if (switchMatch[2]) {
      // Quoted value
      sw.value = switchMatch[2];
    } else if (switchMatch[3]) {
      // Unquoted value
      sw.value = switchMatch[3];
    }

    switches.push(sw);
    switchPositions.push({
      start: switchMatch.index,
      end: switchMatch.index + switchMatch[0].length,
    });
  }

  // Find argument (text before first switch, excluding field name)
  let argument: string | undefined;
  if (remaining.length > 0) {
    const firstSwitchPos =
      // SAFETY: length > 0 guarantees index 0 exists
      switchPositions.length > 0 ? switchPositions[0]!.start : remaining.length;
    const beforeSwitch = remaining.slice(0, firstSwitchPos).trim();

    // Remove quotes if present
    if (beforeSwitch.startsWith('"') && beforeSwitch.endsWith('"')) {
      argument = beforeSwitch.slice(1, -1);
    } else if (beforeSwitch) {
      argument = beforeSwitch;
    }
  }

  return {
    type,
    raw: instruction,
    ...(argument !== undefined ? { argument } : {}),
    switches,
  };
}

/**
 * Get the format switch value (\* or \@)
 *
 * @param instruction - Parsed instruction
 * @returns Format string or undefined
 */
export function getFormatSwitch(
  instruction: ParsedFieldInstruction,
): string | undefined {
  const formatSwitch = instruction.switches.find(
    (s) => s.switch === "*" || s.switch === "@",
  );
  return formatSwitch?.value;
}

/**
 * Check if field has MERGEFORMAT switch (preserve formatting)
 *
 * @param instruction - Parsed instruction
 * @returns true if MERGEFORMAT is present
 */
export function hasMergeFormat(instruction: ParsedFieldInstruction): boolean {
  const formatSwitch = instruction.switches.find((s) => s.switch === "*");
  return formatSwitch?.value?.toUpperCase() === "MERGEFORMAT";
}

// ============================================================================
// SIMPLE FIELD PARSING
// ============================================================================

/**
 * Parse a simple field element (w:fldSimple)
 *
 * @param node - The w:fldSimple XML element
 * @param styles - Style definitions for parsing content runs
 * @param theme - Theme for color/font resolution
 * @returns Parsed SimpleField object
 */
export function parseSimpleField(
  node: XmlElement,
  styles: StyleMap | null,
  theme: Theme | null,
): SimpleField {
  const instruction = getAttribute(node, "w", "instr") ?? "";
  const fieldType = parseFieldType(instruction);

  const field: SimpleField = {
    type: "simpleField",
    instruction,
    fieldType,
    content: [],
  };

  // Check for fldLock
  const fldLock = getAttribute(node, "w", "fldLock");
  if (fldLock === "1" || fldLock === "true") {
    field.fldLock = true;
  }

  // Check for dirty (needs update)
  const dirty = getAttribute(node, "w", "dirty");
  if (dirty === "1" || dirty === "true") {
    field.dirty = true;
  }

  // Parse content (child runs and hyperlinks)
  const children = findChildren(node, "w", "r");
  for (const child of children) {
    const run = parseRun(child, styles, theme);
    field.content.push(run);
  }

  // Note: Hyperlinks inside fields would need their own parsing
  // For now, we handle runs which is the common case

  return field;
}

// ============================================================================
// COMPLEX FIELD STATE TRACKING
// ============================================================================

/**
 * State machine for tracking complex field parsing
 */
export type ComplexFieldState = "outside" | "code" | "result";

/**
 * Complex field parsing context
 */
export type ComplexFieldContext = {
  /** Current state */
  state: ComplexFieldState;
  /** Accumulated instruction text */
  instruction: string;
  /** Runs in the field code section */
  codeRuns: Run[];
  /** Runs in the result section */
  resultRuns: Run[];
  /** Whether field is locked */
  fldLock: boolean;
  /** Whether field needs update */
  dirty: boolean;
  /** Nesting level (for nested fields) */
  nestingLevel: number;
};

/**
 * Create a new complex field context
 */
export function createComplexFieldContext(): ComplexFieldContext {
  return {
    state: "outside",
    instruction: "",
    codeRuns: [],
    resultRuns: [],
    fldLock: false,
    dirty: false,
    nestingLevel: 0,
  };
}

/**
 * Reset the context for a new field
 */
export function resetComplexFieldContext(ctx: ComplexFieldContext): void {
  ctx.state = "code";
  ctx.instruction = "";
  ctx.codeRuns = [];
  ctx.resultRuns = [];
  ctx.fldLock = false;
  ctx.dirty = false;
}

/**
 * Finalize a complex field from its context
 *
 * @param ctx - The field context
 * @returns The parsed ComplexField
 */
export function finalizeComplexField(ctx: ComplexFieldContext): ComplexField {
  return {
    type: "complexField",
    instruction: ctx.instruction.trim(),
    fieldType: parseFieldType(ctx.instruction),
    fieldCode: ctx.codeRuns,
    fieldResult: ctx.resultRuns,
    ...(ctx.fldLock && { fldLock: true }),
    ...(ctx.dirty && { dirty: true }),
  };
}

// ============================================================================
// FIELD VALUE EXTRACTION
// ============================================================================

/**
 * Get the current display value of a field
 *
 * @param field - The field (simple or complex)
 * @returns The display text
 */
export function getFieldDisplayValue(field: Field): string {
  if (field.type === "simpleField") {
    return field.content
      .filter((c): c is Run => "content" in c)
      .map((run) => getRunText(run))
      .join("");
  }
  return field.fieldResult.map((run) => getRunText(run)).join("");
}

/**
 * Helper to get text from a run (simplified)
 */
function getRunText(run: Run): string {
  return run.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Check if field represents a page number
 *
 * @param field - The field to check
 * @returns true if this is a page number field
 */
export function isPageNumberField(field: Field): boolean {
  return field.fieldType === "PAGE";
}

/**
 * Check if field represents total page count
 *
 * @param field - The field to check
 * @returns true if this is a total pages field
 */
export function isTotalPagesField(field: Field): boolean {
  return field.fieldType === "NUMPAGES";
}

/**
 * Check if field is a date/time field
 *
 * @param field - The field to check
 * @returns true if this is a date/time field
 */
export function isDateTimeField(field: Field): boolean {
  const dateTimeTypes: FieldType[] = [
    "DATE",
    "TIME",
    "CREATEDATE",
    "SAVEDATE",
    "PRINTDATE",
    "EDITTIME",
  ];
  return dateTimeTypes.includes(field.fieldType);
}

/**
 * Check if field is a document property field
 *
 * @param field - The field to check
 * @returns true if this is a document property field
 */
export function isDocPropertyField(field: Field): boolean {
  const docPropTypes: FieldType[] = [
    "AUTHOR",
    "TITLE",
    "SUBJECT",
    "KEYWORDS",
    "COMMENTS",
    "FILENAME",
    "FILESIZE",
    "TEMPLATE",
    "REVNUM",
    "DOCPROPERTY",
    "DOCVARIABLE",
  ];
  return docPropTypes.includes(field.fieldType);
}

/**
 * Check if field is a cross-reference field
 *
 * @param field - The field to check
 * @returns true if this is a cross-reference field
 */
export function isReferenceField(field: Field): boolean {
  const refTypes: FieldType[] = ["REF", "PAGEREF", "NOTEREF"];
  return refTypes.includes(field.fieldType);
}

/**
 * Check if field is a mail merge field
 *
 * @param field - The field to check
 * @returns true if this is a mail merge field
 */
export function isMergeField(field: Field): boolean {
  const mergeTypes: FieldType[] = [
    "MERGEFIELD",
    "IF",
    "NEXT",
    "NEXTIF",
    "ASK",
    "SET",
  ];
  return mergeTypes.includes(field.fieldType);
}

/**
 * Check if field is a hyperlink field
 *
 * @param field - The field to check
 * @returns true if this is a hyperlink field
 */
export function isHyperlinkField(field: Field): boolean {
  return field.fieldType === "HYPERLINK";
}

/**
 * Check if field is a TOC/Index field
 *
 * @param field - The field to check
 * @returns true if this is a TOC or index field
 */
export function isTocField(field: Field): boolean {
  const tocTypes: FieldType[] = ["TOC", "TOA", "INDEX"];
  return tocTypes.includes(field.fieldType);
}

// ============================================================================
// FIELD VALUE COMPUTATION
// ============================================================================

/**
 * Compute the value for a page number field
 *
 * @param pageNumber - Current page number
 * @param instruction - Parsed instruction for format switches
 * @returns Formatted page number string
 */
export function computePageNumber(
  pageNumber: number,
  instruction?: ParsedFieldInstruction,
): string {
  if (!instruction) {
    return String(pageNumber);
  }

  const format = getFormatSwitch(instruction);
  if (!format) {
    return String(pageNumber);
  }

  // Handle common format switches
  switch (format.toUpperCase()) {
    case "ROMAN":
      return toRoman(pageNumber);
    case "ALPHABETIC":
      return toLetter(pageNumber);
    default:
      return String(pageNumber);
  }
}

/**
 * Convert number to uppercase Roman numerals
 */
function toRoman(num: number): string {
  if (num <= 0 || num > 3999) {
    return String(num);
  }

  const values = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const symbols = [
    "M",
    "CM",
    "D",
    "CD",
    "C",
    "XC",
    "L",
    "XL",
    "X",
    "IX",
    "V",
    "IV",
    "I",
  ];

  let result = "";
  let remaining = num;

  for (let i = 0; i < values.length; i++) {
    // SAFETY: i is bounded by values.length; values and symbols have equal length
    while (remaining >= values[i]!) {
      result += symbols[i]!;
      remaining -= values[i]!;
    }
  }

  return result;
}

/**
 * Convert number to letter (A, B, ... Z, AA, AB, ...)
 */
function toLetter(num: number): string {
  if (num <= 0) {
    return String(num);
  }

  let result = "";
  let n = num;

  while (n > 0) {
    n--;
    result = String.fromCodePoint(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }

  return result;
}

/**
 * Format a date according to a format string
 *
 * Supports common OOXML date format codes:
 * - M, MM, MMM, MMMM - Month
 * - d, dd, ddd, dddd - Day
 * - yy, yyyy - Year
 * - h, hh, H, HH - Hour
 * - m, mm - Minute (in time context)
 * - s, ss - Second
 * - AM/PM, am/pm - AM/PM indicator
 *
 * @param date - The date to format
 * @param format - The format string
 * @returns Formatted date string
 */
export function formatDate(date: Date, format: string): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const shortMonths = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const pad = (n: number) => n.toString().padStart(2, "0");

  const hour12 = date.getHours() % 12 || 12;
  const ampm = date.getHours() >= 12 ? "PM" : "AM";
  // Single-pass token replacement prevents replacement text from being
  // interpreted as more tokens (`AM/PM` contains `M`, `Monday` contains `d`).
  return format.replace(
    /AM\/PM|am\/pm|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|hh|h|HH|H|mm|m|ss|s/gu,
    (token) => {
      switch (token) {
        case "yyyy":
          return date.getFullYear().toString();
        case "yy":
          return (date.getFullYear() % 100).toString().padStart(2, "0");
        // SAFETY: getMonth() returns 0-11, matching array indices.
        case "MMMM":
          return months[date.getMonth()]!;
        case "MMM":
          return shortMonths[date.getMonth()]!;
        case "MM":
          return pad(date.getMonth() + 1);
        case "M":
          return (date.getMonth() + 1).toString();
        // SAFETY: getDay() returns 0-6, matching array indices.
        case "dddd":
          return days[date.getDay()]!;
        case "ddd":
          return shortDays[date.getDay()]!;
        case "dd":
          return pad(date.getDate());
        case "d":
          return date.getDate().toString();
        case "hh":
          return pad(hour12);
        case "h":
          return hour12.toString();
        case "HH":
          return pad(date.getHours());
        case "H":
          return date.getHours().toString();
        case "mm":
          return pad(date.getMinutes());
        case "m":
          return date.getMinutes().toString();
        case "ss":
          return pad(date.getSeconds());
        case "s":
          return date.getSeconds().toString();
        case "AM/PM":
          return ampm;
        case "am/pm":
          return ampm.toLowerCase();
        default:
          return token;
      }
    },
  );
}

// ============================================================================
// FIELD COLLECTION
// ============================================================================

/**
 * Collect all fields from a document content array
 *
 * @param content - Array of paragraph content items
 * @returns Array of all fields found
 */
function isField(item: unknown): item is Field {
  return (
    item !== null &&
    typeof item === "object" &&
    "type" in item &&
    (item.type === "simpleField" || item.type === "complexField")
  );
}

export function collectFields(content: unknown[]): Field[] {
  return content.filter(isField);
}

/**
 * Get all fields of a specific type
 *
 * @param fields - Array of fields
 * @param fieldType - The field type to filter by
 * @returns Filtered array of fields
 */
export function getFieldsByType(
  fields: Field[],
  fieldType: FieldType,
): Field[] {
  return fields.filter((f) => f.fieldType === fieldType);
}

/**
 * Find all page number fields
 *
 * @param fields - Array of fields
 * @returns Array of PAGE fields
 */
export function getPageNumberFields(fields: Field[]): Field[] {
  return getFieldsByType(fields, "PAGE");
}

/**
 * Find all merge fields
 *
 * @param fields - Array of fields
 * @returns Array of MERGEFIELD fields
 */
export function getMergeFields(fields: Field[]): Field[] {
  return getFieldsByType(fields, "MERGEFIELD");
}

/**
 * Extract merge field names from fields
 *
 * @param fields - Array of fields
 * @returns Array of merge field names
 */
export function getMergeFieldNames(fields: Field[]): string[] {
  return getMergeFields(fields)
    .map((f) => {
      const parsed = parseFieldInstruction(f.instruction);
      return parsed.argument;
    })
    .filter((name): name is string => !!name);
}
