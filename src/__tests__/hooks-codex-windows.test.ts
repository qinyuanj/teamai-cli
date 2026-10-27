import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileHooks, removeHooks } from '../hooks.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The base64 PowerShell launcher fork releases up to 0.27 wrote for Windows Codex. */
function forkLauncher(event: string, matcher?: string): string {
  const encode = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
  const dispatch = `teamai hook-dispatch ${event} --tool codex${matcher ? ` --matcher ${matcher}` : ''} 2>/dev/null || true`;
  return `powershell.exe -NoProfile -NonInteractive -Command "& (${encode('C:/Program Files/Git/bin/bash.exe')}) -lc (${encode(dispatch)}); exit 0 # teamai hook-dispatch"`;
}

describe('Windows Codex hooks written by the fork', () => {
  it('are replaced by the upstream entries, keep user hooks, and stay removable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-fork-'));
    dirs.push(root);
    const hooksPath = path.join(root, 'hooks.json');
    const user = { hooks: [{ type: 'command', command: 'echo user' }] };
    const entry = (event: string, matcher?: string) => ({ matcher: matcher ?? '*', hooks: [{ type: 'command', command: forkLauncher(event, matcher) }] });
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: {
      SessionStart: [user, entry('session-start')],
      Stop: [entry('stop')],
      PostToolUse: [entry('post-tool-use'), entry('post-tool-use', 'TodoWrite')],
      UserPromptSubmit: [entry('prompt-submit')],
    } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    await reconcileHooks(hooksPath, 'codex', []);
    const first = fs.readFileSync(hooksPath, 'utf8');
    expect(first).not.toContain('FromBase64String');
    const hooks = JSON.parse(first).hooks as Record<string, Array<{ hooks: Array<{ command: string; commandWindows?: string }> }>>;
    expect(hooks.SessionStart[0]).toEqual(user);
    const managed = Object.values(hooks).flat().flatMap((group) => group.hooks).filter((hook) => hook.command !== 'echo user');
    expect(managed.length).toBeGreaterThan(0);
    expect(managed.every((hook) => hook.commandWindows?.endsWith('2>nul & exit 0'))).toBe(true);

    await reconcileHooks(hooksPath, 'codex', []);
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(first);
    await removeHooks(hooksPath, 'codex');
    expect(JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks.SessionStart).toEqual([user]);
  });
});
