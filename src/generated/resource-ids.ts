/** Backend-owned resource ID recognition. Preserve values verbatim; markers are not authority.
 * Random IDs may carry an environment marker. Content-derived media IDs do not.
 * Legacy URL-safe suffixes remain accepted alongside current random suffixes.
 */
const environment = "(?:(?:stage|qa|development)_)?";
export const RESOURCE_ID_PATTERNS = {
  account: new RegExp(`^${environment}acc_[A-Za-z0-9_-]+$`),
  agent: new RegExp(`^${environment}agt_[A-Za-z0-9_-]+$`),
  connection: new RegExp(`^${environment}acn_[A-Za-z0-9_-]+$`),
  screen: new RegExp(`^${environment}scr_[A-Za-z0-9_-]+$`),
  playlist: new RegExp(`^${environment}pl_[A-Za-z0-9_-]+$`),
  release: new RegExp(`^${environment}rel_[A-Za-z0-9_-]+$`),
  media: /^med_[A-Za-z0-9_-]+$/,
};
export type ResourceIDKind = keyof typeof RESOURCE_ID_PATTERNS;
export function isResourceID(value: unknown, kind: ResourceIDKind): value is string {
  return typeof value === "string" && RESOURCE_ID_PATTERNS[kind].test(value);
}
