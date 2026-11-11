import type { RepoInfo } from '../types.js';

/**
 * Git host for Gitea repos.
 *
 * Gitea has no public flagship instance, so unlike GitLab there is no sensible
 * default host: an unconfigured Gitea is a configuration error, not a fallback
 * to some public platform. `giteaHost` therefore returns null and every caller
 * that needs a host reports the missing config.
 *
 * Configuration:
 *   - `GITEA_URL`: base URL of the instance, e.g. `https://gitea.example.com`
 *     or `http://gitea.internal:3000` → host including the port, lowercased.
 *   - An explicit full URL in parseRepoInput always wins over it.
 *
 * Read at call time rather than at module load so tests and long-lived
 * processes see env changes, matching gitlabBaseUrl()'s lazy resolution.
 */
export function giteaHost(): string | null {
  const giteaUrl = process.env.GITEA_URL?.trim();

  if (giteaUrl) {
    try {
      const host = new URL(giteaUrl).host.toLowerCase();

      if (host) return host;
    } catch {
      // ignore malformed GITEA_URL — giteaBaseUrl() reports it with a better message
    }
  }

  return null;
}

/**
 * True when `url` is on the configured Gitea instance: the same host and port as `GITEA_URL`, nothing looser. Every
 * check that decides whether a URL is Gitea's, and so whether it may receive the token, goes through this.
 */
export function isGiteaInstanceUrl(url: string): boolean {
  const configured = giteaHost();

  if (!configured) return false;

  try {
    return new URL(url).host.toLowerCase() === configured;
  } catch {
    return false;
  }
}

function requireHost(): string {
  const host = giteaHost();

  if (!host) {
    throw new Error(
      'No Gitea instance configured. Set GITEA_URL (e.g. https://gitea.example.com) '
        + 'before using a bare owner/repo, or pass the full repo URL.',
    );
  }

  return host;
}

/**
 * Parse user input into a standardized RepoInfo structure for Gitea.
 * Supports:
 *   - Short format: `owner/repo` (requires GITEA_URL)
 *   - HTTPS / HTTP URL, on any self-hosted host and port
 *   - SSH URL (`git@host:owner/repo.git`)
 *
 * Unlike GitLab, Gitea has no subgroups: a repo path is always exactly two
 * segments, `owner/repo`. Extra trailing segments are a web route, not a
 * namespace, so they are stripped by `stripGiteaRoutePath` rather than folded
 * into the owner.
 */
export function parseGiteaRepoInput(input: string): RepoInfo {
  const trimmed = stripGiteaRoutePath(input.trim());

  // Full URL — host (and port) come from the URL itself.
  const httpsMatch = trimmed.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);

  if (httpsMatch) {
    return buildRepoInfo(httpsMatch[1], httpsMatch[2], httpsMatch[3], schemeOf(trimmed));
  }

  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/);

  if (sshMatch) {
    return buildRepoInfo(sshMatch[1], sshMatch[2], sshMatch[3], 'https');
  }

  // Short format: owner/repo on the configured instance.
  const shortMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);

  if (shortMatch) {
    return buildRepoInfo(requireHost(), shortMatch[1], shortMatch[2], schemeForConfiguredHost());
  }

  const hostHint = giteaHost() ?? 'gitea.example.com';
  throw new Error(
    `Unrecognized Gitea repo format: "${trimmed}"\n`
      + '  Supported formats:\n'
      + '    owner/repo\n'
      + `    https://${hostHint}/owner/repo.git\n`
      + `    git@${hostHint}:owner/repo.git`,
  );
}

/** Gitea web routes that may follow a repo root in a copied browser URL. */
const GITEA_ROUTE_SEGMENTS = [
  'src', 'pulls', 'issues', 'commit', 'commits', 'releases', 'wiki', 'actions',
  'raw', 'compare', 'settings', 'activity', 'projects', 'packages', 'milestone',
  'tags', 'branches', 'find', 'blame', 'stars', 'watchers', 'forks',
].join('|');

const GITEA_ROUTE_RE = new RegExp(
  `^(https?://[^/]+/[^/]+/[^/]+)/(?:${GITEA_ROUTE_SEGMENTS})(?:/|$)`,
  'i',
);

/**
 * Strip Gitea web routes that follow the repo root — `/src/branch/main`,
 * `/pulls/42`, `/issues`, `/commit/<sha>`.
 *
 * Without this, `https://host/owner/repo/pulls/42` fails the strict
 * two-segment URL pattern and the user gets a format error for a URL they
 * legitimately copied from the browser.
 */
function stripGiteaRoutePath(input: string): string {
  const match = input.match(GITEA_ROUTE_RE);

  return match ? match[1] : input;
}

function schemeOf(url: string): 'http' | 'https' {
  return /^http:\/\//i.test(url) ? 'http' : 'https';
}

/**
 * Scheme to use for the configured instance when the user typed a bare
 * `owner/repo`. Taken from GITEA_URL because self-hosted Gitea on an internal
 * network is very often plain http; defaulting to https would produce a clone
 * URL that cannot connect.
 */
function schemeForConfiguredHost(): 'http' | 'https' {
  const giteaUrl = process.env.GITEA_URL?.trim();

  if (giteaUrl) {
    try {
      if (new URL(giteaUrl).protocol === 'http:') return 'http';
    } catch {
      // fall through to https
    }
  }

  return 'https';
}

function buildRepoInfo(
  host: string,
  owner: string,
  repo: string,
  scheme: 'http' | 'https',
): RepoInfo {
  return {
    owner,
    repo,
    httpsUrl: `${scheme}://${host}/${owner}/${repo}.git`,
    // Gitea addresses repos as /repos/{owner}/{repo}, not by an encoded id, but
    // projectId is part of the shared RepoInfo shape; keep it consistent with
    // the other providers so callers that log or key off it still work.
    projectId: encodeURIComponent(`${owner}/${repo}`),
  };
}
