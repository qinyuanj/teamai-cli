/**
 * Compare two semver version strings.
 * Handles prerelease suffixes: a version with prerelease (e.g. 1.2.3-beta.1)
 * is always older than the same numeric version without one, and two
 * prereleases of one core compare by their identifiers (semver §11).
 * Returns: -1 if a < b, 0 if equal, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const dashA = a.indexOf('-');
  const dashB = b.indexOf('-');
  const coreA = dashA < 0 ? a : a.slice(0, dashA);
  const coreB = dashB < 0 ? b : b.slice(0, dashB);
  const preA = dashA < 0 ? undefined : a.slice(dashA + 1);
  const preB = dashB < 0 ? undefined : b.slice(dashB + 1);

  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < len; i++) {
    const pa = partsA[i] ?? 0;
    const pb = partsB[i] ?? 0;

    if (pa > pb) return 1;

    if (pa < pb) return -1;
  }

  // Numeric cores are equal — prerelease is lower than release (semver §11)
  if (preA && !preB) return -1;

  if (!preA && preB) return 1;

  if (!preA || !preB) return 0;

  const idsA = preA.split('.');
  const idsB = preB.split('.');

  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const ia = idsA[i];
    const ib = idsB[i];

    if (ia === undefined) return -1;

    if (ib === undefined) return 1;

    if (ia === ib) continue;
    const numA = /^\d+$/.test(ia);
    const numB = /^\d+$/.test(ib);

    if (numA && numB) return Number(ia) < Number(ib) ? -1 : 1;

    if (numA !== numB) return numA ? -1 : 1;

    return ia < ib ? -1 : 1;
  }

  return 0;
}
