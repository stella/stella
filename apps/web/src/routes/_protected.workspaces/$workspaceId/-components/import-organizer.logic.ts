const DATE_PATTERNS = [
  /(?:^|[\s._-])(?<year>20\d{2}|19\d{2})[._-]?(?<month>0[1-9]|1[0-2])[._-]?(?<day>0[1-9]|[12]\d|3[01])(?:$|[\s._-])/u,
  /(?:^|[\s._-])(?<day>0?[1-9]|[12]\d|3[01])[._-](?<month>0?[1-9]|1[0-2])[._-](?<year>20\d{2}|19\d{2})(?:$|[\s._-])/u,
] as const;

const EXTENSION_PATTERN = /(\.[A-Za-z0-9]{1,12})$/u;
const RESERVED_PATH_CHARS = /[<>:"/\\|?*]/gu;
const TOKEN_SEPARATORS = /[\s._-]+/gu;
const MAX_SUGGESTED_FILENAME_LENGTH = 180;

export type ImportSuggestion = {
  id: string;
  file: File;
  originalName: string;
  suggestedName: string;
  folderPath: string;
  detectedDate: string | null;
  documentType: string;
};

export type FileNameSuggestionInput = {
  id: string;
  originalName: string;
};

export type FileNameSuggestion = Omit<ImportSuggestion, "file">;

export const buildImportSuggestions = (
  files: readonly File[],
): ImportSuggestion[] => {
  const suggestions = buildFileNameSuggestions(
    files.map((file, index) => ({
      id: `${index}-${file.name}`,
      originalName: file.name,
    })),
  );

  const importSuggestions: ImportSuggestion[] = [];
  for (let index = 0; index < suggestions.length; index++) {
    const suggestion = suggestions.at(index);
    const file = files.at(index);
    if (!suggestion || !file) {
      continue;
    }

    importSuggestions.push({
      ...suggestion,
      file,
    });
  }

  return importSuggestions;
};

export const buildFileNameSuggestions = (
  files: readonly FileNameSuggestionInput[],
): FileNameSuggestion[] => {
  const suggestions = files.map(({ id, originalName }) => {
    const detectedDate = extractIsoDate(stripExtension(originalName));
    return {
      id,
      originalName,
      suggestedName: cleanFileName(originalName),
      folderPath: "",
      detectedDate,
      documentType: "",
    };
  });

  return makeSuggestedNamesUnique(suggestions);
};

export const normalizeFolderPath = (value: string): string =>
  value
    .split("/")
    .map((part) => sanitizePathSegment(part))
    .filter((part) => part.length > 0)
    .join("/");

export const normalizeSuggestedFileName = (
  value: string,
  fallbackName: string,
): string => {
  const sanitized = sanitizePathSegment(value);
  if (sanitized.length > 0) {
    return truncateFilename(sanitized);
  }
  return truncateFilename(sanitizePathSegment(fallbackName));
};

export const getSuggestedFolderOptions = (
  suggestions: readonly FileNameSuggestion[],
): string[] => {
  const options = new Set<string>();
  for (const suggestion of suggestions) {
    const folderPath = normalizeFolderPath(suggestion.folderPath);
    if (folderPath.length > 0) {
      options.add(folderPath);
    }
  }
  return [...options];
};

const cleanFileName = (fileName: string): string => {
  const extension = getExtension(fileName);
  const baseName = stripExtension(fileName);
  const cleanBase = sanitizePathSegment(
    baseName.replace(TOKEN_SEPARATORS, " "),
  );
  const fallbackBase = sanitizePathSegment(baseName);
  return truncateFilename(`${cleanBase || fallbackBase}${extension}`);
};

const extractIsoDate = (value: string): string | null => {
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(value);
    const groups = match?.groups;
    if (!groups) {
      continue;
    }

    const year = groups["year"];
    const month = groups["month"]?.padStart(2, "0");
    const day = groups["day"]?.padStart(2, "0");
    if (!year || !month || !day) {
      continue;
    }

    const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (
      date.getUTCFullYear() === Number(year) &&
      date.getUTCMonth() + 1 === Number(month) &&
      date.getUTCDate() === Number(day)
    ) {
      return `${year}-${month}-${day}`;
    }
  }
  return null;
};

const stripExtension = (fileName: string): string =>
  fileName.replace(EXTENSION_PATTERN, "");

const getExtension = (fileName: string): string => {
  const match = EXTENSION_PATTERN.exec(fileName);
  return match?.[1] ?? "";
};

const sanitizePathSegment = (value: string): string =>
  stripControlCharacters(value)
    .replace(RESERVED_PATH_CHARS, " ")
    .replace(/\s+/gu, " ")
    .trim();

const stripControlCharacters = (value: string): string => {
  let result = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 32) {
      continue;
    }
    result += char;
  }
  return result;
};

const truncateFilename = (fileName: string): string => {
  if (fileName.length <= MAX_SUGGESTED_FILENAME_LENGTH) {
    return fileName;
  }

  const extension = getExtension(fileName);
  const baseName = stripExtension(fileName);
  const maxBaseLength = MAX_SUGGESTED_FILENAME_LENGTH - extension.length;
  return `${baseName.slice(0, maxBaseLength).trim()}${extension}`;
};

const makeSuggestedNamesUnique = (
  suggestions: readonly FileNameSuggestion[],
): FileNameSuggestion[] => {
  const counts = new Map<string, number>();
  const uniqueSuggestions: FileNameSuggestion[] = [];

  for (const suggestion of suggestions) {
    const key = `${suggestion.folderPath.toLowerCase()}/${suggestion.suggestedName.toLowerCase()}`;
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);

    if (count === 0) {
      uniqueSuggestions.push(suggestion);
      continue;
    }

    uniqueSuggestions.push({
      ...suggestion,
      suggestedName: appendDuplicateSuffix(suggestion.suggestedName, count + 1),
    });
  }

  return uniqueSuggestions;
};

const appendDuplicateSuffix = (fileName: string, count: number): string => {
  const extension = getExtension(fileName);
  const baseName = stripExtension(fileName);
  return truncateFilename(`${baseName} (${count})${extension}`);
};
