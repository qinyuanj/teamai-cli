import { z } from 'zod';

const AdditionalContextSchema = z.object({ hookSpecificOutput: z.object({ additionalContext: z.string() }) });

/**
 * A hook reply as Kimi Code takes it. Kimi reads `message` (or plain text) from a JSON reply and drops the rest, so
 * `additionalContext` would never reach the model. It only reads a reply on UserPromptSubmit (measured on 2.4.1).
 */
export function kimiHookReply(output: string): string {
  try {
    const reply = AdditionalContextSchema.safeParse(JSON.parse(output));

    return reply.success ? JSON.stringify({ message: reply.data.hookSpecificOutput.additionalContext }) : output;
  } catch {
    return output;
  }
}

/**
 * Asks the model to relay a message the host will not show by itself.
 *
 * Only ever prefixed to a message meant for the user, and only when the host
 * hides it. Claude Code prints the Stop payload as "Stop hook feedback", so
 * adding this there makes the user read the order and then read the message a
 * second time from the model (#719).
 */
export const RELAY_TO_USER_PREFIX =
  'Print the following message verbatim to the user (do NOT paraphrase, summarize, or explain its origin):\n\n';

/**
 * Whether the host puts the Stop payload in front of the user by itself.
 *
 * Only decides whether a *delivered* payload needs the model to relay it. It
 * says nothing about whether the payload is delivered at all: OpenCode's plugin
 * spawns the dispatch with stdout ignored (`src/opencode-hooks.ts`), so its Stop
 * payload reaches neither the user nor the model. That gap predates #719 and is
 * tracked separately; either answer here is equally inert for OpenCode.
 */
export function hostShowsStopPayload(tool: string): boolean {
  // Cursor feeds followup_message to the model and shows nothing.
  return (tool?.toLowerCase() ?? '') !== 'cursor';
}

/**
 * Prepare a message addressed to the user for the Stop payload.
 *
 * Messages addressed to the *model*, such as the recall declaration nudge, do
 * not go through here: asking the model to read one out to the user turns
 * bookkeeping into terminal noise.
 */
export function relayWhenHidden(message: string, tool: string): string {
  return hostShowsStopPayload(tool) ? message : RELAY_TO_USER_PREFIX + message;
}

/**
 * Format Stop hook STDOUT for the given AI tool.
 *
 * Shape only. Whether a message addressed to the user needs the model to relay
 * it is decided by `relayWhenHidden`, before the message gets here.
 *
 * Schema choice per tool:
 * - Cursor: `{ followup_message }` (Cursor stop hook docs).
 * - Everyone else (Claude / unknown): `{ hookSpecificOutput: { hookEventName:
 *   'Stop', additionalContext } }` (Claude Code stop hook docs — the "additional
 *   context that continues the conversation" branch, NOT top-level `stopReason`,
 *   which requires `continue:false` and aborts the run).
 *
 * CodeBuddy, WorkBuddy and the Codex family never reach here: their callers
 * check `stopStdoutUnsupported` and stash the message for the next
 * UserPromptSubmit instead.
 */
export function formatStopHookOutput(message: string, tool: string): string {
  const normalized = tool?.toLowerCase() ?? '';

  if (normalized === 'cursor') {
    return JSON.stringify({ followup_message: message });
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: message,
    },
  });
}
