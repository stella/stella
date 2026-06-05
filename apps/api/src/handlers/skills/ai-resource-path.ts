// AI-drafted companion files are restricted to Markdown under the three
// editable roots, but may nest into subfolders so a draft can mirror a real
// taxonomy (e.g. references/cz/act-110.md). Storage already permits nesting
// (resources/resource-path.ts); this is the stricter shape we let the model
// emit. The kind is inferred from the first segment.
export const AI_RESOURCE_PATH_PATTERN =
  /^(references|prompts|knowledge)\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.md$/u;

export const isAiResourcePath = (path: string): boolean =>
  AI_RESOURCE_PATH_PATTERN.test(path);
