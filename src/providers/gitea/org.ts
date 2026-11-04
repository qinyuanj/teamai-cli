import type { OrgRepoInfo } from '../types.js';
import { getGiteaToken, giteaBaseUrl } from './gitea-api.js';

/** Largest accepted response body: 50 MB, so a hostile server cannot run the process out of memory. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Gitea's default API page cap is 50; asking for more is silently clamped. */
const DEFAULT_PER_PAGE = 50;
const DEFAULT_MAX_REPOS = 200;

interface GiteaRepoApiItem {
  id: number;
  name: string;
  full_name: string;
  description?: string | null;
  clone_url: string;
  html_url?: string;
  archived?: boolean;
  language?: string | null;
  stars_count?: number;
  updated_at?: string;
}

/** Map a repo entry from the Gitea API onto OrgRepoInfo. */
function mapItem(item: GiteaRepoApiItem): OrgRepoInfo {
  return {
    url: item.clone_url,
    fullName: item.full_name,
    name: item.name,
    description: item.description ?? undefined,
    primaryLanguage: item.language ?? undefined,
    archived: item.archived ?? false,
    stars: item.stars_count,
    // Gitea exposes no dedicated pushed_at on this endpoint; updated_at is the
    // closest signal and is what the web UI sorts by.
    pushedAt: item.updated_at,
  };
}

/**
 * List the repos of a Gitea organization or user (light metadata).
 *
 * Organizations and users are separate endpoints, and a missing organization
 * answers 404. So `/orgs/{owner}/repos` goes first and a 404 falls back to
 * `/users/{owner}/repos`: repos in a personal namespace can be imported too.
 *
 * @param owner   organization or user name
 * @param opts.maxRepos  upper limit, default 200
 * @throws Error when the token is missing, the owner is not found or not
 *   accessible, or the API answers with any other HTTP error
 */
export async function giteaListOrgRepos(
  owner: string,
  opts?: { maxRepos?: number },
): Promise<OrgRepoInfo[]> {
  const token = getGiteaToken();

  if (!token) {
    throw new Error(
      'Gitea token unavailable: set GITEA_TOKEN (or GITEA_ACCESS_TOKEN / GITEA_PAT).',
    );
  }

  const maxRepos = opts?.maxRepos ?? DEFAULT_MAX_REPOS;
  const encodedOwner = encodeURIComponent(owner);
  const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/json' };
  const apiBase = `${giteaBaseUrl()}/api/v1`;

  const collected: OrgRepoInfo[] = [];
  let scope: 'orgs' | 'users' = 'orgs';
  let page = 1;

  while (collected.length < maxRepos) {
    const url = `${apiBase}/${scope}/${encodedOwner}/repos`
      + `?limit=${DEFAULT_PER_PAGE}&page=${page}`;

    const resp = await fetch(url, { headers, redirect: 'manual' });

    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`Unexpected redirect from Gitea API: ${resp.status}`);
    }

    if (resp.status === 404) {
      // Only retry as a user namespace before any page succeeded — a 404 mid-
      // pagination is a real error, not a namespace mismatch.
      if (scope === 'orgs' && page === 1) {
        scope = 'users';
        continue;
      }

      throw new Error(`Gitea org ${owner} not found or no access`);
    }

    if (!resp.ok) {
      throw new Error(`Gitea API HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }

    // Read the body as a stream, enforcing MAX_RESPONSE_BYTES.
    const reader = resp.body?.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        received += value.length;

        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error(`Gitea API response exceeds ${MAX_RESPONSE_BYTES} bytes`);
        }

        chunks.push(value);
      }
    }

    const bodyText = Buffer.concat(chunks).toString('utf-8').trim();

    if (!bodyText) break;

    let items: GiteaRepoApiItem[];

    try {
      // SAFETY: narrowed to an array below; each entry is read field by field, with defaults for absent ones.
      items = JSON.parse(bodyText) as GiteaRepoApiItem[];
    } catch {
      throw new Error(`Gitea API returned a malformed repo list for ${owner}`);
    }

    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      collected.push(mapItem(item));

      if (collected.length >= maxRepos) break;
    }

    if (items.length < DEFAULT_PER_PAGE) break;
    page++;
  }

  return collected;
}
