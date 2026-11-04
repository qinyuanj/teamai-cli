import { RepoNotFoundError } from '../providers/types.js';
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
  }),
}));

// ─── Imports after mocks ────────────────────────────────

import { spawnSync } from 'node:child_process';
import { parseGiteaRepoInput, giteaHost } from '../providers/gitea/repo-url.js';
import {
  giteaIsAuthenticated,
  giteaWhoami,
  giteaRepoClone,
  giteaCreateRepo,
  giteaPrCreate,
  getGiteaToken,
  giteaBaseUrl,
  giteaAuthHeaderValue,
} from '../providers/gitea/gitea-api.js';
import { giteaListOrgRepos } from '../providers/gitea/org.js';
import { fetchGiteaPR } from '../providers/gitea/mr-fetch.js';
import { detectProvider, getProvider } from '../providers/registry.js';
import { GiteaProvider } from '../providers/gitea/index.js';

const mockedSpawnSync = spawnSync as Mock;

const HOST = 'gitea.example.com';
const BASE = `https://${HOST}`;

/** Set up a fully configured Gitea instance for tests that need one. */
function configureGitea(url = BASE, token = 'gta_secret'): void {
  process.env.GITEA_URL = url;
  process.env.GITEA_TOKEN = token;
}

/** Minimal fetch mock returning a JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Response whose body streams `body` through a reader, as org.ts expects. */
function streamResponse(body: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => undefined,
      }),
    },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ─── repo-url parsing ───────────────────────────────────

describe('parseGiteaRepoInput', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITEA_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('parses bare owner/repo against the configured instance', () => {
    process.env.GITEA_URL = BASE;
    const info = parseGiteaRepoInput('team/teamai-cli');
    expect(info.owner).toBe('team');
    expect(info.repo).toBe('teamai-cli');
    expect(info.httpsUrl).toBe(`${BASE}/team/teamai-cli.git`);
    expect(info.projectId).toBe('team%2Fteamai-cli');
  });

  it('rejects bare owner/repo when no instance is configured', () => {
    expect(() => parseGiteaRepoInput('team/repo')).toThrow(/No Gitea instance configured/);
  });

  it('keeps the http scheme and port of an internal instance for bare input', () => {
    process.env.GITEA_URL = 'http://gitea.internal:3000';
    const info = parseGiteaRepoInput('agent/teamai-cli');
    expect(info.httpsUrl).toBe('http://gitea.internal:3000/agent/teamai-cli.git');
  });

  it('parses an https URL, host taken from the URL itself', () => {
    const info = parseGiteaRepoInput('https://git.other.com/o/r.git');
    expect(info.owner).toBe('o');
    expect(info.repo).toBe('r');
    expect(info.httpsUrl).toBe('https://git.other.com/o/r.git');
  });

  it('parses an http URL with a port', () => {
    const info = parseGiteaRepoInput('http://lzxsvn:3000/agent/teamai-cli.git');
    expect(info.httpsUrl).toBe('http://lzxsvn:3000/agent/teamai-cli.git');
  });

  it('parses an ssh URL', () => {
    const info = parseGiteaRepoInput('git@gitea.example.com:team/repo.git');
    expect(info.owner).toBe('team');
    expect(info.repo).toBe('repo');
  });

  it.each([
    [`${BASE}/o/r/pulls/42`],
    [`${BASE}/o/r/src/branch/main`],
    [`${BASE}/o/r/issues`],
    [`${BASE}/o/r/commit/abc123`],
  ])('strips the web route from %s', (url) => {
    const info = parseGiteaRepoInput(url);
    expect(info.owner).toBe('o');
    expect(info.repo).toBe('r');
  });

  it('rejects a three-segment path — Gitea has no subgroups', () => {
    expect(() => parseGiteaRepoInput('group/subgroup/repo')).toThrow(/Unrecognized Gitea repo/);
  });

  it('reads the host including the port from GITEA_URL', () => {
    process.env.GITEA_URL = 'http://gitea.internal:3000';
    expect(giteaHost()).toBe('gitea.internal:3000');
  });

  it('returns null when nothing is configured — Gitea has no public host', () => {
    expect(giteaHost()).toBeNull();
  });
});

// ─── base URL + token resolution ────────────────────────

describe('giteaBaseUrl', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITEA_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('strips trailing slashes', () => {
    process.env.GITEA_URL = `${BASE}///`;
    expect(giteaBaseUrl()).toBe(BASE);
  });

  it('rejects a GITEA_URL without a scheme by name', () => {
    process.env.GITEA_URL = 'gitea.example.com';
    expect(() => giteaBaseUrl()).toThrow(/Invalid GITEA_URL/);
  });

  it('rejects a non-http protocol', () => {
    process.env.GITEA_URL = 'ftp://gitea.example.com';
    expect(() => giteaBaseUrl()).toThrow(/Invalid GITEA_URL/);
  });

  it('reports missing configuration when nothing is set', () => {
    expect(() => giteaBaseUrl()).toThrow(/No Gitea instance configured/);
  });

});

describe('getGiteaToken', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    delete process.env.GITEA_TOKEN;
    delete process.env.GITEA_ACCESS_TOKEN;
    delete process.env.GITEA_PAT;
  });

  it('reads GITEA_TOKEN', () => {
    process.env.GITEA_TOKEN = 'gta_aaa';
    expect(getGiteaToken()).toBe('gta_aaa');
  });

  it('accepts GITEA_ACCESS_TOKEN as an alias', () => {
    process.env.GITEA_ACCESS_TOKEN = 'gta_bbb';
    expect(getGiteaToken()).toBe('gta_bbb');
  });

  it('accepts GITEA_PAT as an alias', () => {
    process.env.GITEA_PAT = 'gta_ccc';
    expect(getGiteaToken()).toBe('gta_ccc');
  });

  it('treats a blank or whitespace-only token as absent', () => {
    process.env.GITEA_TOKEN = '   ';
    expect(getGiteaToken()).toBeNull();
    expect(giteaIsAuthenticated()).toBe(false);
  });

  it('trims a trailing newline from a token read out of a file', () => {
    process.env.GITEA_TOKEN = 'gta_ddd\n';
    expect(getGiteaToken()).toBe('gta_ddd');
  });
});

// ─── clone ──────────────────────────────────────────────

describe('giteaRepoClone', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    configureGitea();
    delete process.env.GITEA_USER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('injects the token via http.extraHeader, never into the URL', () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    giteaRepoClone('team/repo', '/tmp/x');

    const [, args] = mockedSpawnSync.mock.calls[0];
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('http.extraHeader=Authorization: Basic ');
    expect(args).toContain(`${BASE}/team/repo.git`);
    expect(args.join(' ')).not.toContain('gta_secret');
  });

  it('uses the token as the Basic username with an empty password by default', () => {
    expect(giteaAuthHeaderValue('tok')).toBe(
      `Authorization: Basic ${Buffer.from('tok:').toString('base64')}`,
    );
  });

  it('uses GITEA_USER as the Basic username when set', () => {
    process.env.GITEA_USER = 'alice';
    expect(giteaAuthHeaderValue('tok')).toBe(
      `Authorization: Basic ${Buffer.from('alice:tok').toString('base64')}`,
    );
  });

  it('clones anonymously when no token is configured', () => {
    delete process.env.GITEA_TOKEN;
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    giteaRepoClone('team/repo', '/tmp/x');

    const [, args] = mockedSpawnSync.mock.calls[0];
    expect(args[0]).toBe('clone');
  });

  it('persists an instance-scoped credential helper that reads the token from the environment', () => {
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    giteaRepoClone('team/repo', '/tmp/x');

    expect(mockedSpawnSync.mock.calls[1][1]).toEqual(['config', '--local', '--replace-all', 'credential.https://gitea.example.com.helper', '']);
    const [, args, opts] = mockedSpawnSync.mock.calls[2];
    expect(args[3]).toBe('credential.https://gitea.example.com.helper');
    const helper = args[4];
    expect(helper).toContain('GITEA_TOKEN');
    expect(helper).toContain('GITEA_ACCESS_TOKEN');
    expect(helper).toContain('GITEA_PAT');
    expect(helper).toContain('GITEA_USER');
    expect(helper).not.toContain('gta_secret');
    expect(opts).toMatchObject({ cwd: '/tmp/x', windowsHide: true });
  });

  it('leaves the clone alone after a failed clone', () => {
    mockedSpawnSync.mockReturnValue({ status: 128, stdout: '', stderr: 'fatal: failed' });
    expect(() => giteaRepoClone('team/repo', '/tmp/x')).toThrow();
    expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('maps a missing repo to RepoNotFoundError', () => {
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'remote: Repository not found',
    });
    expect(() => giteaRepoClone('team/repo', '/tmp/x')).toThrow(RepoNotFoundError);
  });

  it('reports other clone failures without leaking credentials', () => {
    mockedSpawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: unable to access https://user:hunter2@gitea.example.com/team/repo.git',
    });
    expect(() => giteaRepoClone('team/repo', '/tmp/x')).toThrow(/git clone failed/);
    expect(() => giteaRepoClone('team/repo', '/tmp/x')).not.toThrow(/hunter2/);
  });
});

// ─── auth ───────────────────────────────────────────────

describe('giteaWhoami', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => configureGitea());

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('sends the Gitea token scheme, not Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ login: 'alice' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await giteaWhoami()).toBe('alice');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/v1/user`);
    expect(init.headers.Authorization).toBe('token gta_secret');
  });

  it('returns null on an API error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    expect(await giteaWhoami()).toBeNull();
  });

  it('returns null when no token is configured', async () => {
    delete process.env.GITEA_TOKEN;
    expect(await giteaWhoami()).toBeNull();
  });
});

// ─── createRepo ─────────────────────────────────────────

describe('giteaCreateRepo', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => configureGitea());

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('uses /user/repos when the owner is the authenticated user', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) return jsonResponse({ login: 'alice' });
      return jsonResponse({ id: 1 }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    await giteaCreateRepo('alice', 'repo');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${BASE}/api/v1/user/repos`);
  });

  it('uses /orgs/{org}/repos when the owner is an organization', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/user')) return jsonResponse({ login: 'alice' });
      if (url.endsWith('/orgs/team')) return jsonResponse({ id: 7 });
      return jsonResponse({ id: 1 }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    await giteaCreateRepo('team', 'repo');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${BASE}/api/v1/orgs/team/repos`);
  });

  it('refuses rather than silently creating in the wrong namespace', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/api/v1/user')) return jsonResponse({ login: 'alice' });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(giteaCreateRepo('ghost', 'repo')).rejects.toThrow(
      /neither the authenticated user nor an organization/,
    );
    // The POST must never have been attempted.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('creates the repo as private', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/user')) return jsonResponse({ login: 'alice' });
      return jsonResponse({ id: 1 }, 201);
    });
    vi.stubGlobal('fetch', fetchMock);

    await giteaCreateRepo('alice', 'repo');
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'repo', private: true });
  });
});

// ─── pull requests ──────────────────────────────────────

describe('giteaPrCreate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => configureGitea());

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('posts head/base and returns the PR web URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ html_url: `${BASE}/team/repo/pulls/7`, number: 7 }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    const url = await giteaPrCreate({
      repo: 'team/repo',
      source: 'feat/x',
      target: 'main',
      title: 'Add x',
      description: 'body',
    });

    expect(url).toBe(`${BASE}/team/repo/pulls/7`);
    const [callUrl, init] = fetchMock.mock.calls[0];
    expect(callUrl).toBe(`${BASE}/api/v1/repos/team/repo/pulls`);
    expect(JSON.parse(init.body)).toEqual({
      head: 'feat/x',
      base: 'main',
      title: 'Add x',
      body: 'body',
    });
  });

  it('requests reviewers in a separate call after creation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ html_url: `${BASE}/team/repo/pulls/7`, number: 7 }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);

    await giteaPrCreate({
      repo: 'team/repo',
      source: 'a',
      target: 'main',
      title: 't',
      reviewers: ['bob'],
    });

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${BASE}/api/v1/repos/team/repo/pulls/7/requested_reviewers`);
    expect(JSON.parse(init.body)).toEqual({ reviewers: ['bob'] });
  });

  it('keeps the PR when requesting reviewers fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ html_url: `${BASE}/team/repo/pulls/7`, number: 7 }, 201))
      .mockRejectedValueOnce(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      giteaPrCreate({
        repo: 'team/repo',
        source: 'a',
        target: 'main',
        title: 't',
        reviewers: ['bob'],
      }),
    ).resolves.toBe(`${BASE}/team/repo/pulls/7`);
  });

  it('falls back to a constructed URL when html_url is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ number: 9 }, 201)));
    const url = await giteaPrCreate({ repo: 'team/repo', source: 'a', target: 'main', title: 't' });
    expect(url).toBe(`${BASE}/team/repo/pulls/9`);
  });

  it('surfaces an API failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, 422)));
    await expect(
      giteaPrCreate({ repo: 'team/repo', source: 'a', target: 'main', title: 't' }),
    ).rejects.toThrow(/Failed to create Gitea PR: 422/);
  });
});

// ─── PR URL parsing + fetch ─────────────────────────────

/** Response whose body is plain text, as the `.diff` endpoint answers. */
function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => { throw new Error('not json'); },
  } as unknown as Response;
}

describe('fetchGiteaPR', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => configureGitea());

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  const pr = {
    title: 'Add gitea provider', body: 'why', user: { login: 'alice' }, merged_at: '2026-01-02T03:04:05Z',
  };
  const commits = [{ sha: 'abc123', commit: { message: 'feat: x\n\nlong body' } }];
  const comments = [
    { id: 1, body: 'Please rename this.', user: { login: 'bob' } },
    { id: 2, body: '<!-- teamai:ci-extract --> curated notes', user: { login: 'teamai' } },
    { id: 3, body: '   ', user: { login: 'bob' } },
  ];

  /** Answers the PR, its commits, its diff, its reviews with their code comments, and its issue comments. */
  function stubPr(overrides: { comments?: unknown; reviews?: unknown; reviewComments?: Record<string, unknown> } = {}) {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/pulls/42')) return jsonResponse(pr);
      const reviewComments = url.match(/\/pulls\/42\/reviews\/(\d+)\/comments/);
      if (reviewComments) return jsonResponse(overrides.reviewComments?.[reviewComments[1]] ?? []);
      if (url.includes('/pulls/42/reviews')) return jsonResponse(overrides.reviews ?? []);
      if (url.includes('/commits')) return jsonResponse(commits);
      if (url.includes('/issues/42/comments')) return jsonResponse(overrides.comments ?? comments);
      return textResponse('diff --git a/x b/x');
    }));
    return calls;
  }

  it('reads code-anchored review comments as threads, then review summaries, then conversation comments', async () => {
    const codeComment = (id: number, body: string, login: string, extra: Record<string, unknown> = {}) => ({
      id, body, user: { login }, path: 'src/app.ts', position: 12, original_position: 0, resolver: null, ...extra,
    });
    stubPr({
      reviews: [
        { id: 7, state: 'REQUEST_CHANGES', body: 'Needs a rename before merge.', user: { login: 'bob' }, comments_count: 2 },
        // A reply in Gitea is a review of its own with an empty body.
        { id: 8, state: 'COMMENT', body: '', user: { login: 'alice' }, comments_count: 1 },
        { id: 9, state: 'APPROVED', body: 'LGTM', user: { login: 'carol' }, comments_count: 0 },
        // A draft review is not shown to anyone else yet.
        { id: 10, state: 'PENDING', body: 'draft', user: { login: 'dave' }, comments_count: 1 },
      ],
      reviewComments: {
        7: [
          codeComment(70, 'Call this loadConfig.', 'bob', { resolver: { login: 'alice' } }),
          codeComment(71, 'Old side note.', 'bob', { path: 'src/old.ts', position: 0, original_position: 4 }),
        ],
        8: [codeComment(80, 'Renamed.', 'alice')],
        10: [codeComment(100, 'draft note', 'dave')],
      },
    });

    const mr = await fetchGiteaPR(`${BASE}/team/repo/pulls/42`);
    expect(mr.discussions).toEqual([
      { file: 'src/app.ts', line: 12, resolved: true, notes: [{ author: 'bob', body: 'Call this loadConfig.' }, { author: 'alice', body: 'Renamed.' }] },
      { file: 'src/old.ts', line: 4, resolved: false, notes: [{ author: 'bob', body: 'Old side note.' }] },
      { notes: [{ author: 'bob', body: 'request changes: Needs a rename before merge.' }] },
      { notes: [{ author: 'carol', body: 'approved: LGTM' }] },
      { notes: [{ author: 'bob', body: 'Please rename this.' }] },
    ]);
  });

  it('assembles title, description, commits, diff and review threads', async () => {
    stubPr();

    const mr = await fetchGiteaPR(`${BASE}/team/repo/pulls/42`);
    expect(mr.title).toBe('Add gitea provider');
    expect(mr.description).toBe('why');
    expect(mr.author).toBe('alice');
    expect(mr.mergedAt).toBe('2026-01-02T03:04:05Z');
    // Subject line only, matching the GitLab provider's `title` field.
    expect(mr.commits).toEqual([{ hash: 'abc123', message: 'feat: x' }]);
    expect(mr.diff).toBe('diff --git a/x b/x');
    // teamai's own CI comments and blank notes are left out of the threads.
    expect(mr.discussions).toEqual([{ notes: [{ author: 'bob', body: 'Please rename this.' }] }]);
  });

  it('leaves the review threads out when discussions are not asked for', async () => {
    const calls = stubPr();

    const mr = await fetchGiteaPR(`${BASE}/team/repo/pulls/42`, { discussions: false });
    expect(mr.discussions).toBeUndefined();
    expect(calls.some((url) => url.includes('/comments'))).toBe(false);
  });

  it('drops comments carrying the custom CI marker too', async () => {
    stubPr({ comments: [{ id: 1, body: 'note <!-- custom-marker -->', user: { login: 'ci' } }, comments[0]] });

    const mr = await fetchGiteaPR(`${BASE}/team/repo/pulls/42`, { commentMarker: '<!-- custom-marker -->' });
    expect(mr.discussions).toEqual([{ notes: [{ author: 'bob', body: 'Please rename this.' }] }]);
  });

  it('still returns the PR when commits, diff and threads fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.endsWith('/pulls/42') ? jsonResponse({ title: 't', body: null }) : jsonResponse({}, 500)
    )));

    const mr = await fetchGiteaPR(`${BASE}/team/repo/pulls/42`);
    expect(mr.title).toBe('t');
    expect(mr.description).toBe('');
    expect(mr.commits).toEqual([]);
    expect(mr.diff).toBe('');
    expect(mr.discussions).toBeUndefined();
  });

  it('throws when the PR itself cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 404)));
    await expect(fetchGiteaPR(`${BASE}/team/repo/pulls/42`)).rejects.toThrow(/Gitea API error 404/);
  });

  it('throws when no token is configured', async () => {
    delete process.env.GITEA_TOKEN;
    await expect(fetchGiteaPR(`${BASE}/team/repo/pulls/42`)).rejects.toThrow(/GITEA_TOKEN is not set/);
  });

  it('refuses a PR URL of another host, so the token goes nowhere else', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(fetchGiteaPR('https://evil.example/team/repo/pulls/42')).rejects.toThrow(/does not match the configured Gitea instance/);
  });

  it('refuses a www. variant of the configured host, as import-mr routing and delivery URLs do', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchGiteaPR(`https://www.${HOST}/team/repo/pulls/42`)).rejects.toThrow(/does not match the configured Gitea instance/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads later commit pages', async () => {
    const pages: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/pulls/42')) return jsonResponse(pr);
      if (url.includes('/commits')) {
        const page = Number(new URL(url).searchParams.get('page') ?? 1);
        pages.push(page);
        return jsonResponse(Array.from({ length: page === 1 ? 50 : 1 }, (_, i) => ({ sha: `c${page}-${i}`, commit: { message: `Change ${page}-${i}` } })));
      }
      return textResponse('diff');
    }));

    const mr = await fetchGiteaPR(`${BASE}/team/repo/pulls/42`);
    expect(pages).toEqual([1, 2]);
    expect(mr.commits).toHaveLength(51);
  });
});

// ─── listOrgRepos ───────────────────────────────────────

describe('giteaListOrgRepos', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => configureGitea());

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('maps Gitea repo fields onto OrgRepoInfo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([
      {
        id: 1,
        name: 'repo',
        full_name: 'team/repo',
        description: 'd',
        clone_url: `${BASE}/team/repo.git`,
        archived: false,
        language: 'TypeScript',
        stars_count: 3,
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])));

    const repos = await giteaListOrgRepos('team');
    expect(repos).toEqual([
      {
        url: `${BASE}/team/repo.git`,
        fullName: 'team/repo',
        name: 'repo',
        description: 'd',
        primaryLanguage: 'TypeScript',
        archived: false,
        stars: 3,
        pushedAt: '2026-01-01T00:00:00Z',
      },
    ]);
  });

  it('falls back to the user namespace when the org 404s on page 1', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/orgs/')) return streamResponse({}, 404);
      return streamResponse([
        { id: 1, name: 'r', full_name: 'alice/r', clone_url: `${BASE}/alice/r.git` },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const repos = await giteaListOrgRepos('alice');
    expect(repos).toHaveLength(1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toContain('/users/alice/repos');
  });

  it('reports a 404 that is neither an org nor a user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse({}, 404)));
    await expect(giteaListOrgRepos('ghost')).rejects.toThrow(/not found or no access/);
  });

  it('requires a token', async () => {
    delete process.env.GITEA_TOKEN;
    await expect(giteaListOrgRepos('team')).rejects.toThrow(/Gitea token unavailable/);
  });

  it('sends the Gitea token scheme', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await giteaListOrgRepos('team');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('token gta_secret');
  });
});

// ─── registry wiring ────────────────────────────────────

describe('registry detection for Gitea', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GITEA_URL;
    delete process.env.TEAMAI_GITEA_HOST;
    delete process.env.GITLAB_URL;
    delete process.env.TEAMAI_GITLAB_HOST;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('detects the configured Gitea host from GITEA_URL', () => {
    process.env.GITEA_URL = BASE;
    expect(detectProvider(`${BASE}/team/repo.git`)).toBe('gitea');
  });

  it('reads Gitea only from GITEA_URL: a host-only setting detects nothing', () => {
    process.env.TEAMAI_GITEA_HOST = HOST;
    expect(detectProvider(`https://${HOST}/team/repo.git`)).toBe('git');
  });

  it('matches an ssh URL against a port-qualified configured host', () => {
    process.env.GITEA_URL = 'http://lzxsvn:3000';
    expect(detectProvider('git@lzxsvn:agent/teamai-cli.git')).toBe('gitea');
  });

  it('matches an http URL that keeps the port', () => {
    process.env.GITEA_URL = 'http://lzxsvn:3000';
    expect(detectProvider('http://lzxsvn:3000/agent/teamai-cli.git')).toBe('gitea');
  });

  it('leaves an unconfigured host on the generic git provider', () => {
    expect(detectProvider('https://git.unknown.com/o/r.git')).toBe('git');
  });

  it('does not shadow a known platform host', () => {
    process.env.GITEA_URL = 'https://github.com';
    expect(detectProvider('https://github.com/o/r.git')).toBe('github');
  });

  it('still resolves a self-hosted GitLab host after the shared-helper refactor', () => {
    process.env.GITLAB_URL = 'https://gl.example.com';
    expect(detectProvider('https://gl.example.com/group/repo.git')).toBe('gitlab');
  });

  it('registers the provider under the name "gitea"', () => {
    const provider = getProvider('gitea');
    expect(provider).toBeInstanceOf(GiteaProvider);
    expect(provider.name).toBe('gitea');
  });
});

// ─── provider surface ───────────────────────────────────

describe('GiteaProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => configureGitea());

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it('lists org repos and answers pull request lookups, but reads no CI', () => {
    const provider = new GiteaProvider();
    expect(typeof provider.listOrgRepos).toBe('function');
    expect(provider.pullRequests.checks).toBeUndefined();
  });

  it('has no default email domain', () => {
    expect(new GiteaProvider().getDefaultEmailDomain()).toBeNull();
  });

  it('reports authentication from the token alone, without a network call', () => {
    expect(new GiteaProvider().isAuthenticated()).toBe(true);
    delete process.env.GITEA_TOKEN;
    expect(new GiteaProvider().isAuthenticated()).toBe(false);
  });

  it('authenticate() returns the username from /user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ login: 'alice' })));
    expect(await new GiteaProvider().authenticate()).toBe('alice');
  });

  it('does not repeat a rejected authentication request without changing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GiteaProvider().authenticate()).rejects.toThrow('Gitea authentication failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ensureInstalled() fails with an actionable message when no token is set', async () => {
    delete process.env.GITEA_TOKEN;
    await expect(new GiteaProvider().ensureInstalled()).rejects.toThrow(/Set GITEA_TOKEN/);
  });

  it('maps a missing repo to the shared RepoNotFoundError', () => {
    mockedSpawnSync.mockReturnValue({ status: 128, stdout: '', stderr: 'Repository not found' });
    expect(() => new GiteaProvider().cloneRepo('team/repo', '/tmp/x')).toThrow(
      /Repo "team\/repo" not found/,
    );
  });
});
