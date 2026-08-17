import path from "node:path";

export function posixNormalize(relativePath: string): string {
  const replaced = relativePath.replaceAll("\\", "/").normalize("NFC");
  const parts: string[] = [];
  for (const part of replaced.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function caseFold(relativePath: string): string {
  return posixNormalize(relativePath).toLocaleLowerCase("en-US");
}

export function hasTraversal(relativePath: string): boolean {
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) {
    return true;
  }
  return relativePath.split(/[/\\]/).some((part) => part === "..");
}

export function pathDepth(relativePath: string): number {
  const normalized = posixNormalize(relativePath);
  if (!normalized) {
    return 0;
  }
  return normalized.split("/").length;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function hasIllegalChars(relativePath: string): boolean {
  if (relativePath.includes("\0")) {
    return true;
  }
  return /[\u0000-\u001f\u007f]/.test(relativePath);
}

/**
 * gitignore-inspired matcher for `.screenrigignore`.
 * Built-in rules are applied separately and cannot be negated.
 */
export function compileIgnore(patterns: string[]): (posixPath: string, isDir: boolean) => boolean {
  const rules = patterns
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const negated = line.startsWith("!");
      const raw = negated ? line.slice(1) : line;
      const directoryOnly = raw.endsWith("/");
      const pattern = directoryOnly ? raw.slice(0, -1) : raw;
      return { negated, directoryOnly, regex: globToRegExp(pattern) };
    });

  return (posixPath: string, isDir: boolean): boolean => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.directoryOnly && !isDir) {
        continue;
      }
      if (rule.regex.test(posixPath) || rule.regex.test(posixPath.split("/").pop() ?? "")) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

function globToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith("/");
  const body = anchored ? pattern.slice(1) : pattern;
  let regex = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "*" && body[i + 1] === "*") {
      if (body[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 2;
      } else {
        regex += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      regex += "[^/]*";
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      continue;
    }
    if (ch && "\\^$+{}[]()|.".includes(ch)) {
      regex += `\\${ch}`;
      continue;
    }
    regex += ch ?? "";
  }
  const source = anchored ? `^${regex}(?:/.*)?$` : `(^|/)${regex}(?:/.*)?$`;
  return new RegExp(source);
}

export const BUILTIN_IGNORE_PATTERNS = [
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "vendor/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".tox/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".eggs/",
  ".idea/",
  ".vscode/",
  ".vs/",
  ".yarn/",
  ".git/",
  ".svn/",
  ".hg/",
  ".bzr/",
  "CVS/",
  "*.map",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.crt",
  "*.cer",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "secrets.json",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "*.swp",
  "*.swo",
  "*~",
  "Thumbs.db",
  "desktop.ini",
];

const builtinMatcher = compileIgnore(BUILTIN_IGNORE_PATTERNS);

export function isDotComponentPath(posixPath: string): boolean {
  return posixNormalize(posixPath)
    .split("/")
    .some((part) => part.startsWith("."));
}

export function isBuiltinIgnored(posixPath: string, isDir: boolean): boolean {
  if (isDotComponentPath(posixPath)) {
    return true;
  }
  return builtinMatcher(posixPath, isDir);
}

export function toPosixRelative(root: string, absolute: string): string {
  return posixNormalize(path.relative(root, absolute));
}
