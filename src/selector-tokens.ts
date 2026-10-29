function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * A tag selector whose tag or tag group names {screen.id} or {screen.field.NAME}.
 * The token is filled for each screen when the selector resolves, so the selector
 * has no single match to preview and no fixed file list to freeze.
 */
export function selectorHasScreenTokens(selector: unknown): boolean {
  const record = asRecord(selector);
  const tags: unknown[] = [record.tag];
  const groups = asRecord(record.tags);
  for (const key of ["all", "any", "none"]) {
    if (Array.isArray(groups[key])) tags.push(...(groups[key] as unknown[]));
  }
  return tags.some((tag) => typeof tag === "string" && tag.includes("{screen."));
}
