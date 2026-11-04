import { createRequire } from 'node:module';
import { z } from 'zod';

/**
 * The fields we read from the CLI's own package.json.
 * Both fields are guaranteed by npm to exist on a published package.
 */
const PackageJsonFieldsSchema = z.object({
  name: z.string(),
  version: z.string(),
});

type PackageJsonFields = z.infer<typeof PackageJsonFieldsSchema>;

/**
 * Load the CLI's package.json.
 *
 * The path `../package.json` is kept literal so it resolves both in source
 * form (src/package-info.ts → ../package.json) and when bundled by tsup
 * (dist/cli.js → ../package.json). Do not move this file into a nested
 * folder without adjusting the bundler banner/resolver.
 */
function loadPackageJson(): PackageJsonFields {
  const require = createRequire(import.meta.url);

  return PackageJsonFieldsSchema.parse(require('../package.json'));
}

/**
 * Get the currently installed CLI version from package.json.
 */
export function getCurrentVersion(): string {
  return loadPackageJson().version;
}

/**
 * Get the currently installed CLI package name from package.json.
 *
 * Used to decide:
 *  - which npm registry to query (public npm vs tnpm)
 *  - the default git provider fallback when users pass a bare `owner/repo`
 *
 * At publish time the internal tnpm pipeline rewrites the name to
 * `@tencent/teamai-cli` (see `.coding-ci.yaml`), so reading it at runtime
 * is a reliable signal of which distribution channel the user installed from.
 */
export function getCurrentPackageName(): string {
  return loadPackageJson().name;
}

/** Public npm registry (open-source users). */
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';

/** Tencent internal tnpm registry (for @tencent/ scoped package). */
const TNPM_REGISTRY = 'http://r.tnpm.oa.com';

/** Self-hosted Gitea package registry (for the @agent/ scoped fork build). */
const AGENT_REGISTRY = 'http://lzxsvn:3000/api/packages/agent/npm/';

/**
 * Resolve the npm registry to use for the given package name.
 * Scoped packages under `@tencent/` go to tnpm, `@agent/` to the self-hosted
 * Gitea registry; everything else to public npm.
 * Honor `TEAMAI_NPM_REGISTRY` env var for manual override (useful for testing
 * or private mirrors).
 */
export function resolveRegistryForPackage(pkgName: string): string {
  const override = process.env.TEAMAI_NPM_REGISTRY?.trim();

  if (override) return override;

  if (pkgName.startsWith('@tencent/')) return TNPM_REGISTRY;

  if (pkgName.startsWith('@agent/')) return AGENT_REGISTRY;

  return PUBLIC_REGISTRY;
}

/**
 * Registry flag for `npm install`. The Gitea registry only hosts the `@agent/`
 * scope and does not proxy public npm, so a global `--registry` would send
 * the dependencies (chalk, ...) there and 404; scope the flag instead so they
 * keep resolving from the user's default registry.
 */
export function registryInstallArg(pkgName: string): string {
  const registry = resolveRegistryForPackage(pkgName);

  if (!process.env.TEAMAI_NPM_REGISTRY?.trim() && pkgName.startsWith('@agent/')) return `--@agent:registry=${registry}`;

  return `--registry=${registry}`;
}
