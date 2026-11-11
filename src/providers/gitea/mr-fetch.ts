import { z } from 'zod';
import { type MRData, type MRFetchOptions, type MRThread } from '../../types.js';
import { log } from '../../utils/logger.js';
import { pruneThreads } from '../mr-threads.js';
import { authHeaders, getGiteaToken, hasNextGiteaPage } from './gitea-api.js';
import { giteaHost, isGiteaInstanceUrl } from './repo-url.js';

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const DIFF_LIMIT = 50000;

/** What a Gitea PR web URL names. */
export interface ParsedGiteaPR {
  /** API base derived from the PR URL's own origin, e.g. http://host:3000/api/v1 */
  apiBase: string;
  owner: string;
  repo: string;
  index: string;
}

/**
 * Parse `https://<host>/<owner>/<repo>/pulls/<index>` into its parts. Gitea's route is the plural `/pulls/`, unlike
 * GitHub's `/pull/`. Gitea has no subgroups, so owner and repo are single segments.
 *
 * Only ever send the token to the *configured* instance. The API base still comes from the URL's own origin (so a
 * self-hosted instance keeps its scheme and port), but the host must match the configured one — otherwise a
 * hand-crafted PR URL on an attacker-controlled host would receive the token (SSRF / credential exfiltration).
 */
export function parseGiteaPRUrl(url: string): ParsedGiteaPR {
  const match = url.match(/^(https?):\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)/i);

  if (!match) throw new Error(`Invalid Gitea PR URL: ${url}`);
  const [, scheme, host, owner, repo, index] = match;
  const configured = giteaHost();

  if (!configured) {
    throw new Error('No Gitea instance configured. Set GITEA_URL before importing a Gitea PR.');
  }

  if (!isGiteaInstanceUrl(url)) {
    throw new Error(
      `Refusing to fetch Gitea PR from "${host}": it does not match the configured Gitea `
        + `instance "${configured}". Set GITEA_URL to this instance if it is trusted.`,
    );
  }

  return { apiBase: `${scheme.toLowerCase()}://${host}/api/v1`, owner, repo, index };
}

const GiteaUserSchema = z.object({ login: z.string().optional() }).nullish();

const GiteaPRSchema = z.object({
  title: z.string(),
  body: z.string().nullish(),
  user: GiteaUserSchema,
  merged_at: z.string().nullish(),
});

const GiteaCommitSchema = z.object({
  sha: z.string(),
  commit: z.object({ message: z.string().optional() }).nullish(),
});

/** A conversation comment: an issue comment, since a pull request is an issue. */
const GiteaIssueCommentSchema = z.object({
  body: z.string(),
  user: GiteaUserSchema,
});

/** A `/pulls/{index}/reviews` entry (the fields read). */
const GiteaReviewSchema = z.object({
  id: z.number(),
  state: z.string().nullish(),
  body: z.string().nullish(),
  user: GiteaUserSchema,
  comments_count: z.number().nullish(),
});

/**
 * A `/pulls/{index}/reviews/{id}/comments` entry (the fields read). `position` is the line on the new side,
 * `original_position` the line on the old side; Gitea sets one and leaves the other 0. `resolver` is who resolved
 * the conversation, null while it is open.
 */
const GiteaReviewCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  user: GiteaUserSchema,
  path: z.string().nullish(),
  position: z.number().nullish(),
  original_position: z.number().nullish(),
  resolver: z.object({ login: z.string().optional() }).nullish(),
});

type ApiHeaders = Record<string, string>;

async function getJson(url: string, headers: ApiHeaders): Promise<{ resp: Response; json: unknown }> {
  const resp = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  if (!resp.ok) throw new Error(`Gitea API error ${resp.status}`);

  return { resp, json: await resp.json() };
}

/** Every page of a paginated list endpoint, each entry parsed with `entry`. */
async function readPages<Entry extends z.ZodType>(url: string, entry: Entry, headers: ApiHeaders): Promise<z.output<Entry>[]> {
  const all: z.output<Entry>[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const { resp, json } = await getJson(`${url}?limit=${PAGE_SIZE}&page=${page}`, headers);
    const items = z.array(entry).parse(json);

    all.push(...items);

    if (!hasNextGiteaPage(resp, items.length, PAGE_SIZE)) break;

    if (page === MAX_PAGES) throw new Error(`Gitea page limit reached for ${new URL(url).pathname}`);
  }

  return all;
}

/**
 * The review threads, without teamai's own CI comments, in the order GitHub's are read:
 *
 *   1. Code comments, grouped into conversations by file and line the way Gitea's UI groups them. A reply is a
 *      review of its own, so the comments of every submitted review are read. A draft (`PENDING`) review is skipped.
 *   2. Each submitted review's summary, prefixed with its verdict (`approved: `, `request changes: `).
 *   3. The conversation comments, one single-note thread each.
 */
async function fetchThreads(repoApi: string, index: string, headers: ApiHeaders): Promise<MRThread[]> {
  const reviews = (await readPages(`${repoApi}/pulls/${index}/reviews`, GiteaReviewSchema, headers))
    .filter((review) => review.state !== 'PENDING');

  const codeComments: z.output<typeof GiteaReviewCommentSchema>[] = [];

  for (const review of reviews) {
    if (review.comments_count === 0) continue;
    // Not paginated: Gitea answers every comment of the review at once.
    const { json } = await getJson(`${repoApi}/pulls/${index}/reviews/${review.id}/comments`, headers);

    codeComments.push(...z.array(GiteaReviewCommentSchema).parse(json));
  }

  const byPosition = new Map<string, MRThread>();

  for (const comment of codeComments.toSorted((a, b) => a.id - b.id)) {
    const note = { author: comment.user?.login, body: comment.body ?? '' };
    const key = `${comment.path ?? ''}\0${comment.position ?? 0}\0${comment.original_position ?? 0}`;
    const thread = byPosition.get(key);

    if (thread) {
      thread.notes.push(note);

      if (comment.resolver) thread.resolved = true;
    } else {
      byPosition.set(key, {
        file: comment.path || undefined,
        line: comment.position || comment.original_position || undefined,
        resolved: comment.resolver === undefined ? undefined : comment.resolver !== null,
        notes: [note],
      });
    }
  }

  const threads = [...byPosition.values()];

  for (const review of reviews) {
    if (!review.body?.trim()) continue;
    const verdict = review.state ? `${review.state.toLowerCase().replace(/_/g, ' ')}: ` : '';

    threads.push({ notes: [{ author: review.user?.login, body: `${verdict}${review.body}` }] });
  }

  const conversation = await readPages(`${repoApi}/issues/${index}/comments`, GiteaIssueCommentSchema, headers);

  threads.push(...conversation.map((comment) => ({ notes: [{ author: comment.user?.login, body: comment.body }] })));

  return pruneThreads(threads);
}

/** Read a Gitea PR, with its secondary data best-effort and its diff capped at 50 KB. */
export async function fetchGiteaPR(url: string, opts: MRFetchOptions = {}): Promise<MRData> {
  const { apiBase, owner, repo, index } = parseGiteaPRUrl(url);
  const token = getGiteaToken();

  if (!token) throw new Error('GITEA_TOKEN is not set.');
  const repoApi = `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const headers = authHeaders(token);
  log.debug(`fetchGiteaPR: ${owner}/${repo}#${index}`);

  const resp = await fetch(`${repoApi}/pulls/${index}`, {
    headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`Gitea API error ${resp.status}: ${await resp.text()}`);
  const pr = GiteaPRSchema.parse(await resp.json());

  let commits: Array<{ hash: string; message: string }> = [];

  try {
    commits = (await readPages(`${repoApi}/pulls/${index}/commits`, GiteaCommitSchema, headers))
      // Only the subject line — matches the GitLab provider's `title`.
      .map((c) => ({ hash: c.sha, message: (c.commit?.message ?? '').split('\n')[0] }));
  } catch (err) {
    log.debug(`Gitea PR commits could not be read, commits stay empty: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Gitea serves the raw unified diff at `<pr>.diff`; unlike GitLab there is no JSON changes endpoint.
  let diff = '';

  try {
    const diffResp = await fetch(`${repoApi}/pulls/${index}.diff`, {
      headers: { ...headers, 'Accept': 'text/plain' },
      redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (diffResp.ok) diff = (await diffResp.text()).slice(0, DIFF_LIMIT);
    else log.debug(`Gitea PR diff could not be read (${diffResp.status}), diff stays empty`);
  } catch (err) {
    log.debug(`Gitea PR diff could not be read, diff stays empty: ${err instanceof Error ? err.message : String(err)}`);
  }

  let discussions: MRThread[] | undefined;

  if (opts.discussions !== false) {
    try {
      discussions = await fetchThreads(repoApi, index, headers);
    } catch (err) {
      log.warn(`Review threads not read (${err instanceof Error ? err.message : String(err)}); the learning is extracted without them`);
    }
  }

  const data: MRData = {
    title: pr.title,
    description: pr.body ?? '',
    author: pr.user?.login,
    mergedAt: pr.merged_at ?? undefined,
    commits,
    diff,
    url,
  };

  if (discussions) data.discussions = discussions;

  return data;
}
