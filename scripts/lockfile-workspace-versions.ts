type WorkspaceVersions = Readonly<Record<string, string>>;

type StringToken = {
  end: number;
  start: number;
  value: string;
};

const skipWhitespace = (text: string, start: number): number => {
  let index = start;
  while (index < text.length && /\s/u.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
};

const stringTokenAt = (text: string, start: number): StringToken => {
  if (text[start] !== '"') {
    throw new TypeError(`expected JSON string at offset ${start}`);
  }
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') {
      const end = index + 1;
      return {
        end,
        start,
        value: JSON.parse(text.slice(start, end)),
      };
    }
    index += 1;
  }
  throw new TypeError(`unterminated JSON string at offset ${start}`);
};

const directPropertyValue = (
  text: string,
  objectStart: number,
  property: string,
  missingMessage?: string,
): number => {
  if (text[objectStart] !== "{") {
    throw new TypeError(`expected object at offset ${objectStart}`);
  }
  let depth = 1;
  let index = objectStart + 1;
  while (index < text.length && depth > 0) {
    const character = text[index];
    if (character === '"') {
      const token = stringTokenAt(text, index);
      if (depth === 1) {
        const colon = skipWhitespace(text, token.end);
        if (text[colon] === ":" && token.value === property) {
          return skipWhitespace(text, colon + 1);
        }
      }
      index = token.end;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
    index += 1;
  }
  throw new TypeError(
    missingMessage ??
      `bun.lock is missing property ${JSON.stringify(property)}`,
  );
};

const rootObjectStart = (text: string): number => {
  const start = skipWhitespace(text, 0);
  if (text[start] !== "{") {
    throw new TypeError("bun.lock must contain a root object");
  }
  return start;
};

/**
 * Updates only workspace self-versions in Bun's text lockfile.
 *
 * Bun does not refresh these cached values on an ordinary install. Recreating the
 * whole lockfile does, but also re-resolves unrelated dependency ranges. Walking
 * the JSON structure lets a release change exactly the intended version strings
 * while preserving every dependency resolution byte-for-byte.
 */
export const syncLockfileWorkspaceVersions = (
  lockText: string,
  workspaceVersions: WorkspaceVersions,
): string => {
  const rootStart = rootObjectStart(lockText);
  const workspacesStart = directPropertyValue(
    lockText,
    rootStart,
    "workspaces",
  );
  if (lockText[workspacesStart] !== "{") {
    throw new TypeError("bun.lock workspaces property must be an object");
  }
  const replacements = Object.entries(workspaceVersions).map(
    ([workspace, version]) => {
      const workspaceStart = directPropertyValue(
        lockText,
        workspacesStart,
        workspace,
        `bun.lock has no workspace entry for ${workspace}`,
      );
      if (lockText[workspaceStart] !== "{") {
        throw new TypeError(
          `bun.lock workspace ${workspace} must be an object`,
        );
      }
      const versionStart = directPropertyValue(
        lockText,
        workspaceStart,
        "version",
      );
      const token = stringTokenAt(lockText, versionStart);
      return {
        end: token.end,
        start: token.start,
        value: JSON.stringify(version),
      };
    },
  );

  replacements.sort((left, right) => right.start - left.start);
  let output = lockText;
  for (const replacement of replacements) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
};
