/**
 * E2E: `teamai import --from-mr` reads a Gitea `/pulls/` URL on a plain-HTTP instance — the PR, its commits, its diff
 * and its review threads — against the local fake Gitea. Drives the built CLI, with a deterministic subprocess
 * standing in for the AI CLI, and asserts the extracted learning and what the extraction prompt was given.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeGitea, type FakeGitea } from '../helpers/fake-gitea.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist', 'index.js');

describe.skipIf(process.platform === 'win32')('import --from-mr with a Gitea pull request', () => {
  let sandbox: string;
  let home: string;
  let gitea: FakeGitea;
  let preload: string;
  let promptFile: string;

  beforeEach(async () => {
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-gitea-import-')));
    home = path.join(sandbox, 'home');
    fs.mkdirSync(home, { recursive: true });
    gitea = await startFakeGitea();
    const repoUrl = `${gitea.url}/team/ai.git`;
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), `team: gitea-e2e\nrepo: ${repoUrl}\nprovider: gitea\nlanguage: en\n`);
    fs.mkdirSync(path.join(home, '.teamai'));
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${JSON.stringify(repo)}`, `  remote: ${repoUrl}`,
      'username: alice', 'scope: user', '',
    ].join('\n'));
    // Answers as `claude -p --output-format json` does: the prompt on stdin, the reply in a result record.
    const ai = path.join(sandbox, 'ai.cjs');
    fs.writeFileSync(ai, `let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(process.env.PROMPT_FILE, prompt);
  process.stdout.write(JSON.stringify({ type: 'result', result: ${JSON.stringify('---\ntitle: Gitea review\n---\nFixture learning.\n')} }));
});
`);
    preload = path.join(sandbox, 'ai-fixture.mjs');
    fs.writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, ...rest) => {
  if ((command === 'where' || command === 'which') && args[0] === 'claude'
    || (command === 'bash' || command === 'zsh') && args[1] === 'command -v claude') return process.execPath;
  return execFileSync(command, args, ...rest);
};
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === process.execPath && args[0] === '-p') return spawn(process.execPath, [${JSON.stringify(ai)}], options);
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`);
    promptFile = path.join(sandbox, 'prompt.txt');
  });

  afterEach(async () => {
    await gitea.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function runCLI(args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, CLI, ...args], {
        cwd: sandbox,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
          GITEA_URL: gitea.url, GITEA_TOKEN: gitea.token, PROMPT_FILE: promptFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';

      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${output}`)); }, 60_000);

      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
  }

  it('imports the PR with its commits, diff and review threads, and leaves teamai comments out', async () => {
    const pull = gitea.openPullRequest('team', 'ai', {
      head: 'teamai/work', title: 'Preserved history', body: 'why this changed',
      commits: [{ sha: 'abc123', message: 'feat: preserve history\n\ndetails' }],
      diff: 'diff --git a/x b/x\n+fixed\n',
      comments: [
        { body: 'Rename this to match the team glossary.', author: 'bob' },
        { body: '<!-- teamai:ci-extract --> our own notes', author: 'teamai' },
      ],
      reviews: [
        {
          state: 'REQUEST_CHANGES', body: 'Keep the history readable.', author: 'carol',
          comments: [{ path: 'src/history.ts', line: 42, body: 'Sort these before writing.', resolvedBy: 'alice' }],
        },
        // Alice's reply to that code comment: a review of its own with no summary.
        { state: 'COMMENT', body: '', author: 'alice', comments: [{ path: 'src/history.ts', line: 42, body: 'Sorted now.' }] },
        { state: 'PENDING', body: 'unsent draft', author: 'dave', comments: [{ path: 'src/x.ts', line: 1, body: 'draft remark' }] },
      ],
    });
    const url = `${gitea.url}/team/ai/pulls/${pull.number}`;
    const outputDir = path.join(sandbox, 'output');

    const result = await runCLI(['import', '--from-mr', url, '--all', '--output', outputDir]);

    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(path.join(outputDir, 'learning.md'), 'utf8')).toContain('Fixture learning.');
    const prompt = fs.readFileSync(promptFile, 'utf8');

    expect(prompt).toContain('Preserved history');
    expect(prompt).toContain('feat: preserve history');
    expect(prompt).toContain('+fixed');
    expect(prompt).toContain('Rename this to match the team glossary.');
    expect(prompt).not.toContain('our own notes');
    // The code-anchored conversation keeps its file, line, resolution and reply; the review summary keeps its verdict.
    expect(prompt).toMatch(/src\/history\.ts:42 \(resolved\)[\s\S]*Sort these before writing\.[\s\S]*Sorted now\./);
    expect(prompt).toContain('request changes: Keep the history readable.');
    expect(prompt).not.toContain('unsent draft');
    expect(prompt).not.toContain('draft remark');
    expect(gitea.requests.some((request) => request.url === '/api/v1/repos/team/ai/pulls/1' && request.authorized)).toBe(true);
    expect(gitea.requests.some((request) => request.url.startsWith('/api/v1/repos/team/ai/issues/1/comments') && request.authorized)).toBe(true);
  });

  it('leaves the review threads out with --no-discussions', async () => {
    gitea.openPullRequest('team', 'ai', { head: 'teamai/work', title: 'No threads', comments: [{ body: 'a note', author: 'bob' }] });

    const result = await runCLI(['import', '--from-mr', `${gitea.url}/team/ai/pulls/1`, '--all', '--no-discussions', '--output', path.join(sandbox, 'output')]);

    expect(result.code, result.output).toBe(0);
    expect(fs.readFileSync(promptFile, 'utf8')).not.toContain('a note');
    expect(gitea.requests.some((request) => request.url.includes('/comments') || request.url.includes('/reviews'))).toBe(false);
  });
});
