import { z } from 'zod';

const MAX_LENGTH = 512;

/**
 * A pull request URL safe to store and publish: https on any host and path, no credentials, no query or fragment, at
 * most 512 characters. Parsing a sanitized value gives it back unchanged, so a stored URL parses to itself.
 *
 * The one exception is the configured Gitea instance: an internal Gitea often serves plain HTTP, so its own pull
 * request URLs are kept as `http`, host and port included. Every other host still must use HTTPS, and a generic Git
 * remote keeps refusing plain HTTP outright (src/providers/git/repo-url.ts).
 */
export const PrUrlSchema = z.string().transform((value, ctx) => {
  const clean = sanitize(value);

  if ('reason' in clean) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: clean.reason });

    return z.NEVER;
  }

  return clean.url;
}).brand<'PrUrl'>();

export type PrUrl = z.infer<typeof PrUrlSchema>;

function sanitize(value: string): { url: string } | { reason: string } {
  if (value.length > MAX_LENGTH) return { reason: `exceeds ${MAX_LENGTH} characters` };
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return { reason: 'is not a valid URL' };
  }

  if (url.protocol !== 'https:' && !isConfiguredGiteaHttp(url)) return { reason: 'must use HTTPS' };

  if (url.username || url.password) return { reason: 'contains credentials' };
  url.search = '';
  url.hash = '';
  const sanitized = url.toString();

  return sanitized.length <= MAX_LENGTH ? { url: sanitized } : { reason: `exceeds ${MAX_LENGTH} characters` };
}

/**
 * True for a plain-HTTP URL of the configured Gitea instance itself — host and port must match, no other host
 * qualifies. The environment is read here rather than through the provider's `giteaHost`, because the workflow
 * snapshot loads this module and must not load provider code (lint rule `workflow-boundaries`). It matches as the
 * provider's `isGiteaInstanceUrl` does: the host and port of `GITEA_URL`, the only Gitea configuration.
 */
function isConfiguredGiteaHttp(url: URL): boolean {
  const base = process.env.GITEA_URL?.trim();

  if (url.protocol !== 'http:' || !base) return false;

  try {
    return url.host.toLowerCase() === new URL(base).host.toLowerCase();
  } catch {
    return false;
  }
}

/** Why a reported URL was not kept is said without the value, which may hold a token. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the URL an agent reported, which no schema has parsed yet
export function sanitizePrUrl(value: unknown): { url: PrUrl; reason?: never } | { url?: never; reason: string } {
  const text = z.string().safeParse(value);

  if (!text.success) return { reason: 'must be a URL string' };
  const parsed = PrUrlSchema.safeParse(text.data);

  return parsed.success ? { url: parsed.data } : { reason: parsed.error.issues[0]?.message ?? 'is not a valid URL' };
}
