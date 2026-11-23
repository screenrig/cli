import path from "node:path";
import { posixNormalize } from "./release-core.js";

export {
  BUILTIN_IGNORE_PATTERNS,
  caseFold,
  compileIgnore,
  hasIllegalChars,
  hasTraversal,
  isBuiltinIgnored,
  isDotComponentPath,
  pathDepth,
  posixNormalize,
  utf8Bytes,
} from "./release-core.js";

export function toPosixRelative(root: string, absolute: string): string {
  return posixNormalize(path.relative(root, absolute));
}
