/**
 * E2E: `teamai push` opens a pull request on a plain-HTTP Gitea instance, against the local fake Gitea. Drives the
 * built CLI and asserts its output, its exit code and the pull request the server holds.
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

describe.skipIf(process.platform === 'win32')('Gitea push opens a pull request', () => {
  let sandbox: string;
  let home: string;
  let gitea: FakeGitea;
  let repoUrl: string;

  function runCLI(args: string[]): Promise<{ code: number | null; output: string }> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      FORCE_COLOR: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GITEA_URL: gitea.url,
      GITEA_TOKEN: gitea.token,
    };

    delete env.CLAUDE_CONFIG_DIR;

    return new Promise((resolve) => {
      const child = spawn('node', [CLI, ...args], { cwd: sandbox, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      child.on('close', (code) => resolve({ code, output }));
    });
  }

  beforeEach(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitea-push-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Alice\n\temail = alice@gitea.test\n[gc]\n\tauto = 0\n');
    gitea = await startFakeGitea();
    repoUrl = `${gitea.url}/team/ai.git`;
    gitea.createRepo('team', 'ai');
    const init = await runCLI(['init', repoUrl, '--scope', 'user', '--role', 'dev', '--agent', 'claude']);

    if (init.code !== 0) throw new Error(`init failed: ${init.output}`);
  });

  afterEach(async () => {
    await gitea.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('pushes the file and opens the PR on the instance, over HTTP with its port', async () => {
    const note = path.join(sandbox, 'note.md');
    fs.writeFileSync(note, '# A note for the team\n');

    const result = await runCLI(['push', '--file', note, '--path', 'docs/note.md']);

    expect(result.output).toContain(`Pull Request created: ${gitea.url}/team/ai/pulls/1`);
    expect(result.code).toBe(0);
    expect(gitea.pulls).toHaveLength(1);
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: teamRepo, encoding: 'utf8' }).trim();

    expect(gitea.pulls[0]?.base).toBe(branch);
    expect(gitea.pulls[0]?.head).toContain('teamai');
    expect(gitea.readFile('team', 'ai', 'docs/note.md', gitea.pulls[0]?.head ?? '')).toBe('# A note for the team\n');
    expect(gitea.requests.some((request) => request.method === 'POST' && request.url === '/api/v1/repos/team/ai/pulls' && request.authorized)).toBe(true);
  });
});
