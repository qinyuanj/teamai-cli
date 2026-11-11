import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * A local Gitea over plain HTTP on a random port: the seam Gitea e2e tests run
 * the real CLI against. It speaks both of Gitea's faces and checks credentials
 * the way Gitea does.
 *
 * - REST under /api/v1 takes `Authorization: token <t>`. Built in: the user,
 *   organizations and repo creation. Add more with `route`.
 * - Git smart HTTP (through `git http-backend`) takes Basic with the token as
 *   the username and an empty or `x-oauth-basic` password, or as the password
 *   under any username. It answers 401 without one, so a private repo really
 *   needs the token.
 */
export interface RecordedRequest {
  method: string;
  /** Path and query as received. */
  url: string;
  /** The Host header: proves the port reached the server. */
  host: string;
  authorization?: string;
  /** Whether the request passed the credential check. */
  authorized: boolean;
}

export interface ApiRequest {
  method: string;
  url: URL;
  params: string[];
  /** The parsed JSON request body, or undefined when there is none. */
  body: unknown;
}

export interface ApiReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type ApiHandler = (request: ApiRequest) => ApiReply | Promise<ApiReply>;

/** A pull request the fake holds, as the REST API answers it. */
export interface FakePullRequest {
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  /** Commit subjects of the PR, oldest first. */
  commits: { sha: string; message: string }[];
  diff: string;
  comments: { body: string; author: string }[];
  /** Submitted reviews in order; a reply to a code comment is a review of its own, as in Gitea. */
  reviews: FakeReview[];
}

/** A pull request review: a verdict, a summary, and the code comments it left. */
export interface FakeReview {
  state: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT' | 'PENDING';
  body: string;
  author: string;
  /** `line` is on the new side of the diff; `resolvedBy` names who resolved the conversation. */
  comments: { path: string; line: number; body: string; resolvedBy?: string }[];
}

export interface FakeGitea {
  /** Base URL, e.g. http://127.0.0.1:43210 — what GITEA_URL is set to. */
  readonly url: string;
  readonly token: string;
  readonly login: string;
  /** Every request received, in order. */
  readonly requests: RecordedRequest[];
  /** Every pull request, in creation order. */
  readonly pulls: FakePullRequest[];
  /** An empty repo with `main` as its default branch; returns the bare repo path. */
  createRepo(owner: string, repo: string): string;
  /** Commit `files` (path → content) on `main` of a repo, creating it if needed. */
  commit(owner: string, repo: string, files: Record<string, string>): void;
  /** The content of a file on `main`, or null when the file or the branch is absent. */
  readFile(owner: string, repo: string, file: string, branch?: string): string | null;
  /** The bare repo's refs, for asserting what a push landed. */
  refs(owner: string, repo: string): string;
  /** Add a pull request fixture and return it. */
  openPullRequest(owner: string, repo: string, pull: Partial<FakePullRequest> & { head: string }): FakePullRequest;
  /** Answer `method` on a path under /api/v1 matching `pattern`; capture groups arrive as `params`. Latest route wins. */
  route(method: string, pattern: RegExp, handler: ApiHandler): void;
  close(): Promise<void>;
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fake Gitea',
  GIT_AUTHOR_EMAIL: 'fake@gitea.test',
  GIT_COMMITTER_NAME: 'Fake Gitea',
  GIT_COMMITTER_EMAIL: 'fake@gitea.test',
};

function basicCredentials(header: string | undefined): [string, string] | null {
  const encoded = /^Basic (.+)$/i.exec(header ?? '')?.[1];

  if (!encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString();
  const colon = decoded.indexOf(':');

  return colon < 0 ? [decoded, ''] : [decoded.slice(0, colon), decoded.slice(colon + 1)];
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startFakeGitea(opts: { token?: string; login?: string; orgs?: string[] } = {}): Promise<FakeGitea> {
  const token = opts.token ?? 'gta_fake_token';
  const login = opts.login ?? 'alice';
  const orgs = new Set(opts.orgs ?? ['team']);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gitea-')));
  const requests: RecordedRequest[] = [];
  const routes: { method: string; pattern: RegExp; handler: ApiHandler }[] = [];
  let base = '';
  const baseUrl = (): string => base;
  const bareRepo = (owner: string, repo: string): string => path.join(root, 'repos', owner, `${repo}.git`);

  const createRepo = (owner: string, repo: string): string => {
    const bare = bareRepo(owner, repo);

    if (!fs.existsSync(bare)) {
      fs.mkdirSync(bare, { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    }

    return bare;
  };

  const route = (method: string, pattern: RegExp, handler: ApiHandler): void => {
    routes.unshift({ method, pattern, handler });
  };

  route('GET', /^\/user$/, () => ({ body: { id: 1, login, username: login } }));
  route('GET', /^\/orgs\/([^/]+)$/, ({ params }) => (
    orgs.has(params[0]) ? { body: { id: 2, username: params[0] } } : { status: 404, body: { message: 'not found' } }
  ));
  const created = (owner: string, name: string): ApiReply => {
    if (fs.existsSync(bareRepo(owner, name))) return { status: 409, body: { message: 'repository already exists' } };
    createRepo(owner, name);

    return { status: 201, body: { name, full_name: `${owner}/${name}`, private: true } };
  };
  route('POST', /^\/user\/repos$/, ({ body }) => created(login, (body as { name: string }).name));
  route('POST', /^\/orgs\/([^/]+)\/repos$/, ({ params, body }) => created(params[0], (body as { name: string }).name));

  // ─── Pull requests ──────────────────────────────────────
  const pulls: FakePullRequest[] = [];
  const openPullRequest = (owner: string, repo: string, pull: Partial<FakePullRequest> & { head: string }): FakePullRequest => {
    const record: FakePullRequest = {
      number: pulls.length + 1, owner, repo, title: 'Change', body: '', base: 'main', state: 'open', merged: false,
      commits: [], diff: '', comments: [], reviews: [], ...pull,
    };

    pulls.push(record);

    return record;
  };
  /** The fields the CLI reads, shaped as Gitea's API shapes them. */
  const pullBody = (pull: FakePullRequest): Record<string, unknown> => ({
    number: pull.number,
    html_url: `${baseUrl()}/${pull.owner}/${pull.repo}/pulls/${pull.number}`,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    created_at: '2026-01-01T10:00:00Z',
    closed_at: pull.state === 'closed' ? '2026-01-02T10:00:00Z' : null,
    merged_at: pull.merged ? '2026-01-02T10:00:00Z' : null,
    merge_commit_sha: pull.merged ? 'm'.repeat(40) : null,
    user: { login },
    head: { ref: pull.head, sha: pull.commits.at(-1)?.sha ?? 'h'.repeat(40), repo: { full_name: `${pull.owner}/${pull.repo}` } },
    base: { ref: pull.base, repo: { full_name: `${pull.owner}/${pull.repo}` } },
  });
  /** A `limit`/`page` slice, with Gitea's `x-next-page` and `x-total-count` headers. */
  const paged = <T>(items: T[], url: URL): ApiReply => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * limit, page * limit);
    const next = page * limit < items.length ? String(page + 1) : undefined;

    return { body: slice, headers: { 'x-total-count': String(items.length), ...(next ? { 'x-next-page': next } : {}) } };
  };
  const pullsOf = (owner: string, repo: string): FakePullRequest[] => pulls.filter((pull) => pull.owner === owner && pull.repo === repo);
  const pullAt = (owner: string, repo: string, index: string): FakePullRequest | undefined => (
    pullsOf(owner, repo).find((pull) => pull.number === Number(index))
  );

  route('POST', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, ({ params, body }) => {
    const input = body as { head: string; base: string; title: string; body?: string };
    const pull = openPullRequest(params[0], params[1], { head: input.head, base: input.base, title: input.title, body: input.body ?? '' });

    return { status: 201, body: pullBody(pull) };
  });
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls$/, ({ params, url }) => {
    const state = url.searchParams.get('state') ?? 'open';
    const listed = pullsOf(params[0], params[1]).filter((pull) => state === 'all' || pull.state === state).toReversed();

    return paged(listed.map(pullBody), url);
  });
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, ({ params }) => {
    const pull = pullAt(params[0], params[1], params[2]);

    return pull ? { body: pullBody(pull) } : { status: 404, body: { message: 'not found' } };
  });
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/commits$/, ({ params, url }) => (
    paged((pullAt(params[0], params[1], params[2])?.commits ?? []).map((commit) => ({ sha: commit.sha, commit: { message: commit.message } })), url)
  ));
  route('POST', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/requested_reviewers$/, () => ({ status: 204 }));
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, ({ params, url }) => (
    paged((pullAt(params[0], params[1], params[2])?.comments ?? []).map((comment, id) => ({
      id, body: comment.body, user: { login: comment.author },
    })), url)
  ));
  // Review ids are the position in `reviews`, plus one; code comment ids grow in review order, as Gitea's do.
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews$/, ({ params, url }) => (
    paged((pullAt(params[0], params[1], params[2])?.reviews ?? []).map((review, i) => ({
      id: i + 1, state: review.state, body: review.body, user: { login: review.author }, comments_count: review.comments.length,
    })), url)
  ));
  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/, ({ params }) => {
    const reviews = pullAt(params[0], params[1], params[2])?.reviews ?? [];
    const at = Number(params[3]) - 1;
    const review = reviews[at];

    if (!review) return { status: 404, body: { message: 'not found' } };
    const firstId = reviews.slice(0, at).reduce((sum, earlier) => sum + earlier.comments.length, 1);

    return {
      body: review.comments.map((comment, i) => ({
        id: firstId + i, body: comment.body, user: { login: review.author }, path: comment.path,
        position: comment.line, original_position: 0, pull_request_review_id: at + 1,
        resolver: comment.resolvedBy ? { login: comment.resolvedBy } : null,
      })),
    };
  });

  route('GET', /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\.diff$/, ({ params }) => ({
    body: pullAt(params[0], params[1], params[2])?.diff ?? '', headers: { 'content-type': 'text/plain' },
  }));

  const serveApi = async (req: IncomingMessage, res: ServerResponse, url: URL, record: RecordedRequest): Promise<void> => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const text = headers['content-type'] === 'text/plain';
      res.writeHead(status, { 'content-type': text ? 'text/plain' : 'application/json', ...headers });
      res.end(text ? String(body ?? '') : JSON.stringify(body ?? null));
    };

    record.authorized = req.headers.authorization === `token ${token}`;

    if (!record.authorized) {
      reply(401, { message: 'token is required' });

      return;
    }

    const apiPath = url.pathname.slice('/api/v1'.length);
    const raw = await readBody(req);

    for (const { method, pattern, handler } of routes) {
      const match = method === req.method ? pattern.exec(apiPath) : null;

      if (match) {
        const answer = await handler({
          method,
          url,
          params: match.slice(1),
          body: raw.length ? JSON.parse(raw.toString()) : undefined,
        });

        reply(answer.status ?? 200, answer.body, answer.headers);

        return;
      }
    }

    reply(404, { message: 'not found' });
  };

  /** Hands a smart-HTTP request to `git http-backend` and relays its CGI response. */
  const serveGit = (req: IncomingMessage, res: ServerResponse, url: URL, record: RecordedRequest): void => {
    const credentials = basicCredentials(req.headers.authorization);
    const usernameIsToken = credentials?.[0] === token && (credentials[1] === '' || credentials[1] === 'x-oauth-basic');

    record.authorized = usernameIsToken || credentials?.[1] === token;

    if (!record.authorized) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Gitea"' });
      res.end();

      return;
    }

    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: path.join(root, 'repos'),
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        REMOTE_USER: login,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let head: Buffer | null = Buffer.alloc(0);

    req.pipe(backend.stdin);
    backend.stdin.on('error', () => undefined);
    backend.stdout.on('data', (chunk: Buffer) => {
      if (!head) {
        res.write(chunk);

        return;
      }

      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');

      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;

      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (name === 'status') status = Number.parseInt(value, 10);
        else headers[name] = value;
      }

      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      head = null;
    });
    backend.on('close', () => {
      if (head) res.writeHead(500);
      res.end();
    });
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake-gitea.invalid');
    const record: RecordedRequest = {
      method: req.method ?? '',
      url: req.url ?? '',
      host: req.headers.host ?? '',
      authorization: req.headers.authorization,
      authorized: false,
    };

    requests.push(record);

    if (url.pathname.startsWith('/api/v1/')) {
      serveApi(req, res, url, record).catch((error: unknown) => {
        res.writeHead(500);
        res.end(String(error));
      });
    } else {
      serveGit(req, res, url, record);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  return {
    url: base,
    token,
    login,
    requests,
    pulls,
    openPullRequest,
    createRepo,
    route,
    commit(owner, repo, files) {
      const bare = createRepo(owner, repo);
      const work = fs.mkdtempSync(path.join(root, 'work-'));
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: work, env: { ...process.env, ...GIT_IDENTITY }, stdio: 'ignore' });
      };

      git('init', '-q', '-b', 'main');
      git('remote', 'add', 'origin', bare);

      if (execFileSync('git', ['--git-dir', bare, 'for-each-ref', 'refs/heads/main'], { encoding: 'utf8' })) {
        git('fetch', '-q', 'origin', 'main');
        git('reset', '-q', '--hard', 'FETCH_HEAD');
      }

      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
        fs.writeFileSync(path.join(work, file), content);
      }

      git('add', '-A');
      git('commit', '-q', '-m', `fixture: ${Object.keys(files).join(', ')}`);
      git('push', '-q', 'origin', 'main');
      fs.rmSync(work, { recursive: true, force: true });
    },
    readFile(owner, repo, file, branch = 'main') {
      try {
        return execFileSync('git', ['--git-dir', bareRepo(owner, repo), 'show', `${branch}:${file}`], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    },
    refs(owner, repo) {
      return execFileSync('git', ['--git-dir', bareRepo(owner, repo), 'for-each-ref'], { encoding: 'utf8' });
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => {
        server.close(resolve);
      });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
