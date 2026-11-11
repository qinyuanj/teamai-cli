import type { GitProvider, PrCreateOptions, PullRequestLookup, RepoInfo, OrgRepoInfo } from '../types.js';
import type { MRData, MRFetchOptions } from '../../types.js';
import { fetchGiteaPR } from './mr-fetch.js';
import {
  ensureGiteaAvailable,
  giteaIsAuthenticated,
  giteaWhoami,
  giteaRepoClone,
  giteaCreateRepo,
  giteaPrCreate,
  giteaFindOpenPull,
  giteaPullHistory,
} from './gitea-api.js';
import { giteaListOrgRepos } from './org.js';
import { parseGiteaRepoInput } from './repo-url.js';

/**
 * Gitea provider (self-hosted instances only — Gitea has no public platform).
 *
 * Uses the Gitea REST API v1 directly — no external CLI is required, only an
 * access token (see gitea-api.ts for env-var conventions).
 */
export class GiteaProvider implements GitProvider {
  readonly name = 'gitea';
  readonly pullRequests: PullRequestLookup = { findOpen: giteaFindOpenPull, history: giteaPullHistory };

  parseRepoInput(input: string): RepoInfo {
    return parseGiteaRepoInput(input);
  }

  isAuthenticated(): boolean {
    return giteaIsAuthenticated();
  }

  async authenticate(): Promise<string> {
    await ensureGiteaAvailable();
    const username = await giteaWhoami();

    if (!username) {
      throw new Error('Gitea authentication failed. Please run `teamai init` again.');
    }

    return username;
  }

  async ensureInstalled(): Promise<void> {
    await ensureGiteaAvailable();
  }

  cloneRepo(repo: string, localPath: string): void {
    giteaRepoClone(repo, localPath);
  }

  async createRepo(owner: string, repo: string): Promise<void> {
    await giteaCreateRepo(owner, repo);
  }

  async createPullRequest(opts: PrCreateOptions): Promise<string> {
    return giteaPrCreate(opts);
  }

  async fetchMergeRequest(url: string, opts?: MRFetchOptions): Promise<MRData> {
    return fetchGiteaPR(url, opts);
  }

  async listOrgRepos(org: string, opts?: { maxRepos?: number }): Promise<OrgRepoInfo[]> {
    return giteaListOrgRepos(org, opts);
  }

  getDefaultEmailDomain(): string | null {
    return null;
  }
}

export { giteaIsAuthenticated, getGiteaToken, giteaBaseUrl } from './gitea-api.js';

export { giteaHost, parseGiteaRepoInput } from './repo-url.js';
