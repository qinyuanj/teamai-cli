import { describe, expect, it } from 'vitest';
import { parseStdin } from '../hook-dispatch-cli.js';
import { skillCandidates } from '../skill-use.js';
import { kimiHookReply } from '../utils/hook-output.js';
import { normalizeToolName, stopStdoutUnsupported } from '../utils/tool-names.js';

describe('what Kimi Code 2.4.1 sends and takes from a hook', () => {
  it('reads the todo tool as TodoWrite', () => {
    expect(normalizeToolName('TodoList')).toBe('TodoWrite');
  });

  it('reads a prompt sent as content parts as its text', () => {
    const stdin = parseStdin(JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: [{ type: 'text', text: 'first' }, { type: 'image', url: 'x' }, { type: 'text', text: 'second' }],
    }), 'prompt-submit');

    expect(stdin.prompt).toBe('first\nsecond');
  });

  it('leaves a prompt sent as a string alone', () => {
    expect(parseStdin(JSON.stringify({ prompt: 'plain' }), 'prompt-submit').prompt).toBe('plain');
  });

  it('turns additionalContext, which Kimi drops, into the message it takes', () => {
    const reply = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'the hint' } });

    expect(JSON.parse(kimiHookReply(reply))).toEqual({ message: 'the hint' });
  });

  it('leaves any other reply as it is', () => {
    expect(kimiHookReply('plain text')).toBe('plain text');
    expect(kimiHookReply('{"continue":true}')).toBe('{"continue":true}');
  });

  it('recognizes the skill load a wildcard PostToolUse reports', () => {
    expect(skillCandidates({
      hook_event_name: 'PostToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'probe-skill' },
    }, 'kimi')).toEqual([{ skill: 'probe-skill' }]);
  });

  it('stashes the Stop hint for the next prompt', () => {
    expect(stopStdoutUnsupported('kimi')).toBe(true);
  });
});
