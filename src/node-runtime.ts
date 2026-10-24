// CVE-2026-111497 is fixed in these supported Node release lines.
export const NODE_RUNTIME_REQUIREMENT = "Node.js 22.23.4+, 24.22.1+, or 26.12.1+ (excluding 23.x and 25.x)";

export function nodeRuntimeSupported(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  const minimum = ({ 22: [23, 4], 24: [22, 1], 26: [12, 1] } as Record<number, [number, number]>)[major];
  return major > 26 || !!minimum && (minor > minimum[0] || minor === minimum[0] && patch >= minimum[1]);
}
