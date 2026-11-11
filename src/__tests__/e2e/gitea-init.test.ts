/**
 * E2E: a Gitea team over plain HTTP on a non-default port, against a local fake
 * Gitea that refuses git and API requests without the token. Drives the built
 * CLI, and asserts its exit code, its output and what reached the server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeGitea, type FakeGitea } from '../helpers/fake-gitea.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

const TEAM_YAML = (repoUrl: string): string => [
  'team: gitea-e2e',
  `repo: ${repoUrl}`,
  'provider: gitea',
  'reviewers: []',
  'language: en',
  '',
].join('\n');

describe.skipIf(process.platform === 'win32')('Gitea team over plain HTTP', () => {
  let sandbox: string;
  let home: string;
  let gitea: FakeGitea;
  let repoUrl: string;

  function runCLI(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FORCE_COLOR: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    };

    delete childEnv.CLAUDE_CONFIG_DIR;

    // A developer's own Gitea settings must not reach the CLI under test.
    for (const name of ['GITEA_URL', 'GITEA_TOKEN', 'GITEA_ACCESS_TOKEN', 'GITEA_PAT', 'GITEA_USER']) {
      if (!(name in env)) delete childEnv[name];
    }

    return new Promise((resolve) => {
      const child = spawn('node', [CLI, ...args], { cwd: sandbox, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      child.on('close', (code) => resolve({ code, output }));
    });
  }

  const giteaEnv = (): Record<string, string> => ({ GITEA_URL: gitea.url, GITEA_TOKEN: gitea.token });
  const init = (env: Record<string, string>, ...extra: string[]): Promise<RunResult> => (
    runCLI(['init', repoUrl, '--scope', 'user', '--role', 'dev', '--agent', 'claude', ...extra], env)
  );
  const teamRepo = (): string => path.join(home, '.teamai', 'team-repo');

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitea-e2e-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Alice\n\temail = alice@gitea.test\n[gc]\n\tauto = 0\n');
    gitea = await startFakeGitea();
    repoUrl = `${gitea.url}/team/ai.git`;
  });

  afterEach(async () => {
    await gitea.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('joins a private team repo with GITEA_TOKEN, keeps http and the port, and leaves no token on disk', async () => {
    gitea.commit('team', 'ai', { 'teamai.yaml': TEAM_YAML(repoUrl) });

    const result = await init(giteaEnv());

    expect(result.output).toContain('Authenticated as alice');
    expect(result.code).toBe(0);
    const host = new URL(gitea.url).host;

    expect(gitea.requests.length).toBeGreaterThan(0);
    expect(gitea.requests.every((request) => request.host === host)).toBe(true);
    expect(gitea.requests.some((request) => request.url === '/api/v1/user' && request.authorized)).toBe(true);
    expect(gitea.requests.some((request) => request.url.startsWith('/team/ai.git/') && request.authorized)).toBe(true);
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: teamRepo(), encoding: 'utf8' }).trim()).toBe(repoUrl);
    expect(fs.readFileSync(path.join(teamRepo(), '.git', 'config'), 'utf8')).not.toContain(gitea.token);
  });

  it('fetches new team commits with GITEA_TOKEN after init', async () => {
    gitea.commit('team', 'ai', { 'teamai.yaml': TEAM_YAML(repoUrl) });
    expect((await init(giteaEnv())).code).toBe(0);

    gitea.commit('team', 'ai', { 'later.md': 'pushed after init\n' });
    const result = await runCLI(['pull'], giteaEnv());

    expect(result.output).not.toMatch(/could not read Username|Authentication failed/i);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(teamRepo(), 'later.md'), 'utf8')).toBe('pushed after init\n');
  });

  it('initializes an empty repo and records provider: gitea', async () => {
    gitea.createRepo('team', 'ai');

    const result = await init(giteaEnv());

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(teamRepo(), 'teamai.yaml'), 'utf8')).toContain('provider: gitea');
    // The team config was pushed, on whatever branch the empty clone started.
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: teamRepo(), encoding: 'utf8' }).trim();

    expect(gitea.readFile('team', 'ai', 'teamai.yaml', branch)).toContain('provider: gitea');
    expect(gitea.refs('team', 'ai')).toContain('refs/heads/teamai-reports');
  });

  it('keeps refusing plain HTTP through generic Git when GITEA_URL is not set', async () => {
    gitea.commit('team', 'ai', { 'teamai.yaml': TEAM_YAML(repoUrl) });

    const result = await init({ GITEA_TOKEN: gitea.token });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('plain HTTP is not supported');
    // Init's self-hosted GitLab probe may knock, but no token and no clone reach the host.
    expect(gitea.requests.filter((request) => request.authorization || request.url.includes('.git/'))).toEqual([]);
  });

  it('refuses --provider gitea without GITEA_URL, naming the variable', async () => {
    const result = await init({ GITEA_TOKEN: gitea.token }, '--provider', 'gitea');

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('GITEA_URL');
    expect(gitea.requests).toEqual([]);
  });

  it('asks for the token when it is missing', async () => {
    const result = await init({ GITEA_URL: gitea.url });

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('GITEA_TOKEN');
  });

  it('doctor checks the Gitea URL and token', async () => {
    gitea.commit('team', 'ai', { 'teamai.yaml': TEAM_YAML(repoUrl) });
    expect((await init(giteaEnv())).code).toBe(0);

    const healthy = await runCLI(['doctor'], giteaEnv());

    expect(healthy.output).toMatch(/✓?.*Gitea instance URL is configured/);
    expect(healthy.output).toMatch(/✓?.*Gitea token is configured/);
    expect(healthy.output).not.toContain('Export GITEA_');

    const missing = await runCLI(['doctor'], {});

    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain('Export GITEA_URL');
    expect(missing.output).toContain('Export GITEA_TOKEN');
  });
});
