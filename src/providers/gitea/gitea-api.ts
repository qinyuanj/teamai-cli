import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { endedRequest, mergedAs, RepoNotFoundError, type PrCreateOptions, type PullRequestRecord, type PullRequestRef } from '../types.js';

import { log } from '../../utils/logger.js';
import { sanitizeGitUrl } from '../../utils/redact.js';
import { isGiteaInstanceUrl, parseGiteaRepoInput } from './repo-url.js';

/**
 * Gitea REST API client (API v1).
 *
 * Gitea exposes a GitHub-shaped REST API under `/api/v1` and needs no external
 * CLI — only an access token. The token is sent via the `Authorization: token`
 * header, which is Gitea's own scheme (not `Bearer`).
 *
 * Auth env-var conventions:
 *   - `GITEA_URL`: base URL of the instance. Gitea has no default host, so every
 *     member must set it; plain `http` and a port are kept as written.
 *   - `GITEA_TOKEN` (primary), `GITEA_ACCESS_TOKEN`, `GITEA_PAT` (aliases)
 *   - `GITEA_USER`: optional Basic-auth username for git-over-HTTP (see below)
 */

// ─── Config ──────────────────────────────────────────────

/**
 * Base URL of the Gitea instance, e.g. https://gitea.example.com.
 *
 * Resolved lazily rather than at module load: an invalid GITEA_URL must fail
 * the Gitea operation that needs it, not crash every module that transitively
 * imports this one.
 */
export function giteaBaseUrl(): string {
  const giteaUrl = process.env.GITEA_URL?.trim();

  if (giteaUrl) {
    // Reject a value `new URL()` cannot parse (most often a missing scheme).
    // Without this every fetch throws "Failed to parse URL" from deep inside
    // undici instead of naming the offending env var.
    try {
      const parsed = new URL(giteaUrl);

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('unsupported protocol');
      }
    } catch {
      throw new Error(
        `Invalid GITEA_URL: "${giteaUrl}". Expected a full base URL including the `
          + 'scheme, e.g. https://gitea.example.com',
      );
    }

    return giteaUrl.replace(/\/+$/, '');
  }

  throw new Error(
    'No Gitea instance configured. Set GITEA_URL, e.g. https://gitea.example.com',
  );
}

/** Base URL for REST API calls (Gitea mounts the API under /api/v1). */
function giteaApiBase(): string {
  return `${giteaBaseUrl()}/api/v1`;
}

/** Resolve the Gitea token from env, honouring the documented aliases. */
export function getGiteaToken(): string | null {
  // Trim and treat blank as absent: CI often declares GITEA_TOKEN with an unset
  // secret (empty string), and `$(cat token)` leaves a trailing newline that
  // undici rejects as an invalid header value.
  for (const raw of [
    process.env.GITEA_TOKEN,
    process.env.GITEA_ACCESS_TOKEN,
    process.env.GITEA_PAT,
  ]) {
    const token = raw?.trim();

    if (token) return token;
  }

  return null;
}

function requireToken(): string {
  const token = getGiteaToken();

  if (!token) {
    throw new Error(
      'Gitea authentication unavailable. Set the GITEA_TOKEN environment variable '
        + '(a Gitea access token with repo scope). GITEA_ACCESS_TOKEN and GITEA_PAT '
        + 'are accepted as aliases.',
    );
  }

  return token;
}

/** Gitea's token scheme is `Authorization: token <t>` — `Bearer` is rejected. */
export function authHeaders(token: string) {
  return {
    'Authorization': `token ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

/** Whether a list endpoint has another page: Gitea answers `x-next-page` when one exists; a short page is the last one either way. */
export function hasNextGiteaPage(response: Response, count: number, limit: number): boolean {
  return !!response.headers?.get('x-next-page') || count >= limit;
}

// ─── Auth ────────────────────────────────────────────────

/** True when a Gitea token is configured (no network check). */
export function giteaIsAuthenticated(): boolean {
  return getGiteaToken() !== null;
}

const GiteaUserSchema = z.object({ login: z.string().optional(), username: z.string().optional() });

/** Fetch the authenticated Gitea username, or null when unavailable. */
export async function giteaWhoami(): Promise<string | null> {
  const token = getGiteaToken();

  if (!token) return null;

  try {
    const resp = await fetch(`${giteaApiBase()}/user`, {
      headers: authHeaders(token),
      redirect: 'manual',
    });

    if (!resp.ok) return null;
    const data = GiteaUserSchema.safeParse(await resp.json());

    // Gitea returns `login`; `username` is kept for older/forked instances.
    return data.success ? (data.data.login ?? data.data.username ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Ensure Gitea is usable. There is no CLI to install — only a token is needed,
 * which `authenticate` then verifies against /user.
 */
export async function ensureGiteaAvailable(): Promise<void> {
  if (getGiteaToken()) return;
  throw new Error(
    'Gitea authentication unavailable. Set GITEA_TOKEN (or GITEA_ACCESS_TOKEN / GITEA_PAT).',
  );
}

// ─── Repo operations ─────────────────────────────────────

/**
 * HTTP Basic auth header for a Gitea access token, passed to git via
 * `-c http.extraHeader=...` so the token stays out of the remote URL and out of
 * the cloned repo's `.git/config`.
 *
 * Gitea accepts the token as the Basic *username* with an empty password (the
 * documented `https://<token>@host/...` form). Some instances behind a reverse
 * proxy that rewrites auth want a real username instead — set `GITEA_USER` for
 * those and the token becomes the password.
 */
export function giteaAuthHeaderArg(token: string): string {
  return `http.extraHeader=${giteaAuthHeaderValue(token)}`;
}

/** The bare `Authorization: Basic ...` value, for callers that build their own -c arg. */
export function giteaAuthHeaderValue(token: string): string {
  const user = process.env.GITEA_USER?.trim();
  const pair = user ? `${user}:${token}` : `${token}:`;

  return `Authorization: Basic ${Buffer.from(pair).toString('base64')}`;
}

/**
 * Credential helper persisted into a clone: reads the token from the environment
 * when git runs, with the precedence of getGiteaToken and the Basic form of
 * giteaAuthHeaderValue. Only this command reaches `.git/config`, never the token.
 */
const GITEA_CREDENTIAL_HELPER = '!f() { test "$1" = get || exit 0; '
  + 't="${GITEA_TOKEN:-${GITEA_ACCESS_TOKEN:-$GITEA_PAT}}"; test -n "$t" || exit 0; '
  + 'echo "username=${GITEA_USER:-$t}"; echo "password=${GITEA_USER:+$t}"; }; f';

function gitConfigLocal(cwd: string, ...args: string[]) {
  return spawnSync('git', ['config', '--local', ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    windowsHide: true,
  });
}

/**
 * Let later fetches and pushes in a clone authenticate from the environment. The
 * empty value first clears inherited helpers for this instance, so a global
 * helper cannot answer first with another account. Scoped to the instance URL,
 * so helpers for other hosts stay in place and the token goes nowhere else.
 */
function persistCredentialHelper(localPath: string, remoteUrl: string): void {
  const key = `credential.${new URL(remoteUrl).origin}.helper`;
  const reset = gitConfigLocal(localPath, '--replace-all', key, '');
  const persisted = reset.status === 0 ? gitConfigLocal(localPath, '--add', key, GITEA_CREDENTIAL_HELPER) : reset;

  if (persisted.status !== 0) {
    log.warn(`Could not persist the Gitea credential helper: ${(persisted.stderr ?? '').trim()}. Pull and push may prompt for credentials.`);
  }
}

/**
 * Clone a Gitea repo to localPath. The token is injected via http.extraHeader
 * rather than embedded in the remote URL, so it is not persisted to
 * `.git/config`; a credential helper serves later git operations.
 */
export function giteaRepoClone(repo: string, localPath: string): void {
  const token = getGiteaToken();
  const remoteUrl = parseGiteaRepoInput(repo).httpsUrl;
  // `-c <key>=<val>` is a git-level option and must precede the `clone`
  // subcommand, matching the http.extraHeader pattern in clone.ts.
  const args: string[] = [];

  if (token) args.push('-c', giteaAuthHeaderArg(token));
  args.push('clone', '--', remoteUrl, localPath);

  const result = spawnSync('git', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
    windowsHide: true,
  });

  if (result.status === 0) {
    if (token) persistCredentialHelper(localPath, remoteUrl);

    return;
  }

  const allOutput = `${result.stderr ?? ''} ${result.stdout ?? ''}`;

  if (
    allOutput.includes('not found')
    || allOutput.includes('does not exist')
    || allOutput.includes('Repository not found')
    || allOutput.includes('could not be found')
  ) {
    throw new RepoNotFoundError(repo);
  }

  throw new Error(`git clone failed: ${sanitizeGitUrl(allOutput).trim()}`);
}

/** True when `owner` is an organization on this instance (as opposed to a user). */
async function isOrg(owner: string, token: string): Promise<boolean> {
  try {
    const resp = await fetch(`${giteaApiBase()}/orgs/${encodeURIComponent(owner)}`, {
      headers: authHeaders(token),
      redirect: 'manual',
    });

    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Create a private Gitea repo.
 *
 * Gitea splits creation across two endpoints: `/user/repos` always creates
 * under the authenticated user, `/orgs/{org}/repos` under an organization.
 * Picking the wrong one silently creates the repo in the wrong namespace, so
 * an owner that is neither the current user nor a visible org is an error
 * rather than a fallback.
 */
export async function giteaCreateRepo(owner: string, repo: string): Promise<void> {
  const token = requireToken();
  const login = await giteaWhoami();
  const body = JSON.stringify({ name: repo, private: true, auto_init: false });

  let endpoint: string;

  if (login && login.toLowerCase() === owner.toLowerCase()) {
    endpoint = `${giteaApiBase()}/user/repos`;
  } else if (await isOrg(owner, token)) {
    endpoint = `${giteaApiBase()}/orgs/${encodeURIComponent(owner)}/repos`;
  } else {
    throw new Error(
      `Cannot create Gitea repo: "${owner}" is neither the authenticated user nor an `
        + 'organization visible to this token. Check the owner name and the token scope.',
    );
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders(token),
    body,
    redirect: 'manual',
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to create Gitea repo: ${resp.status} ${await resp.text().catch(() => '')}`,
    );
  }
}

// ─── Pull requests ───────────────────────────────────────

const GiteaCreatedPullSchema = z.object({ html_url: z.string().optional(), number: z.number().optional() });

/** Create a Pull Request via the Gitea REST API and return its web URL. */
export async function giteaPrCreate(opts: PrCreateOptions): Promise<string> {
  const token = requireToken();
  const { owner, repo } = parseGiteaRepoInput(opts.repo);
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const resp = await fetch(`${giteaApiBase()}/repos/${path}/pulls`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      head: opts.source,
      base: opts.target,
      title: opts.title,
      body: opts.description ?? '',
    }),
    redirect: 'manual',
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to create Gitea PR: ${resp.status} ${await resp.text().catch(() => '')}`,
    );
  }

  const parsed = GiteaCreatedPullSchema.safeParse(await resp.json().catch(() => undefined));

  if (!parsed.success) throw new Error('Gitea PR created but its response was not readable.');
  const pr = parsed.data;

  await requestReviewers(path, pr.number, opts.reviewers, token);

  if (pr.html_url) return pr.html_url;

  if (pr.number) return `${giteaBaseUrl()}/${owner}/${repo}/pulls/${pr.number}`;
  throw new Error('Gitea PR created but response did not include html_url.');
}

/** Gitea caps a page at 50 items by default. */
const LOOKUP_PAGE = 50;

/** How many history pages TeamAI reads before it calls the history unlistable. */
const MAX_HISTORY_PAGES = 100;

function isRepo(fullName: string | undefined, owner: string, name: string): boolean {
  return fullName?.toLowerCase() === `${owner}/${name}`.toLowerCase();
}

const GiteaOpenPullSchema = z.object({
  html_url: z.string(),
  state: z.string(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable().optional() }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});

/** The web URL of the open pull request from `source` into `target` within `repo`, if any. */
export async function giteaFindOpenPull({ repo, source, target, timeoutMs }: PullRequestRef): Promise<string | undefined> {
  const token = requireToken();
  const { owner, repo: name } = parseGiteaRepoInput(repo);
  const query = new URLSearchParams({ state: 'open', limit: String(LOOKUP_PAGE) });

  const response = await fetch(`${giteaApiBase()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?${query}`, {
    headers: authHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`Gitea answered the open pull request lookup with HTTP ${response.status}. Check the token's access to the repository.`);
  const pulls = z.array(GiteaOpenPullSchema).safeParse(await response.json().catch(() => undefined));

  if (!pulls.success) throw new Error('Gitea answered the open pull request lookup with data TeamAI cannot read.');

  const found = pulls.data.find((pull) => pull.state === 'open' && pull.head.ref === source && pull.base.ref === target
    && isRepo(pull.head.repo?.full_name, owner, name) && isRepo(pull.base.repo.full_name, owner, name));

  if (!found && pulls.data.length >= LOOKUP_PAGE) {
    throw new Error('Gitea listed more open pull requests than one page, so TeamAI cannot tell whether this branch has one.');
  }

  return found?.html_url;
}

const GiteaPullHistorySchema = GiteaOpenPullSchema.extend({
  title: z.string(),
  created_at: z.string(),
  closed_at: z.string().nullish(),
  merged: z.boolean().nullish(),
  merged_at: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  head: GiteaOpenPullSchema.shape.head.extend({ sha: z.string().nullish() }),
});

/**
 * Every pull request from `source` into `target` in `repo`, newest first, with how it ended. A request from a fork
 * with the same branch name is not one of them. Unlike the open-request lookup this pages through the whole history:
 * a repository with more than one page of pull requests must still answer, not fail forever.
 */
export async function giteaPullHistory({ repo, source, target, timeoutMs }: PullRequestRef): Promise<PullRequestRecord[]> {
  const token = requireToken();
  const { owner, repo: name } = parseGiteaRepoInput(repo);
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const found: z.infer<typeof GiteaPullHistorySchema>[] = [];

  for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
    const query = new URLSearchParams({ state: 'all', limit: String(LOOKUP_PAGE), page: String(page) });

    const response = await fetch(`${giteaApiBase()}/repos/${path}/pulls?${query}`, {
      headers: authHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) throw new Error(`Gitea answered the pull request history lookup with HTTP ${response.status}. Check the token's access to the repository.`);
    const pulls = z.array(GiteaPullHistorySchema).safeParse(await response.json().catch(() => undefined));

    if (!pulls.success) throw new Error('Gitea answered the pull request history lookup with data TeamAI cannot read.');
    found.push(...pulls.data);

    if (!hasNextGiteaPage(response, pulls.data.length, LOOKUP_PAGE)) break;

    if (page === MAX_HISTORY_PAGES) throw new Error(`Gitea listed more than ${MAX_HISTORY_PAGES * LOOKUP_PAGE} pull requests, so TeamAI cannot tell how this branch's requests ended.`);
  }

  const mine = found.filter((pull) => pull.head.ref === source && pull.base.ref === target
    && isRepo(pull.head.repo?.full_name, owner, name) && isRepo(pull.base.repo.full_name, owner, name));

  if (mine.some((pull) => !isGiteaInstanceUrl(pull.html_url))) throw new Error('Gitea answered the pull request history lookup with a URL on another host.');

  return mine.map((pull) => endedRequest({
    url: pull.html_url, title: pull.title, openedAt: pull.created_at,
    state: pull.merged || pull.merged_at ? 'merged' : pull.state, closedAt: pull.merged_at ?? pull.closed_at,
    merge: mergedAs({ head: pull.head.sha, commit: pull.merge_commit_sha }),
  }));
}

/**
 * Request reviewers on a freshly created PR.
 *
 * Separate call because Gitea has no `reviewers` field on PR creation, and
 * non-fatal: an unassignable reviewer must not lose the PR that already exists.
 */
async function requestReviewers(
  path: string,
  number: number | undefined,
  reviewers: string[] | undefined,
  token: string,
): Promise<void> {
  if (!number || !reviewers?.length) return;

  try {
    await fetch(`${giteaApiBase()}/repos/${path}/pulls/${number}/requested_reviewers`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ reviewers }),
      redirect: 'manual',
    });
  } catch {
    // Non-fatal — the PR exists; reviewers can be added in the web UI.
  }
}
