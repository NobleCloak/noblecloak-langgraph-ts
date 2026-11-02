/** What the model reads when a governed call does not run, and the code that travels with it. */
import { ToolMessage } from '@langchain/core/messages';

import type { DenialCode } from './errors.js';

/** The key under which a denial carries its code. */
export const DENIAL_KEY = 'noblecloak';

export const NOT_RUN = 'The tool was not run.';

/** The code a governed call's denial carries, or undefined for any other message. */
export function denialCodeOf(message: unknown): DenialCode | undefined {
  if (!(message instanceof ToolMessage)) return undefined;
  const marker = message.additional_kwargs[DENIAL_KEY];
  if (typeof marker !== 'object' || marker === null || !('code' in marker)) return undefined;
  return typeof marker.code === 'string' ? (marker.code as DenialCode) : undefined;
}

/** A denial the model reads as the tool's result. It carries its code for the caller. */
export function denialMessage(
  toolName: string,
  toolCallId: string,
  code: DenialCode,
  text: string
): ToolMessage {
  const message = new ToolMessage({
    content: text,
    name: toolName,
    tool_call_id: toolCallId,
    status: 'error',
  });
  // Set on the message, not passed to the constructor: @langchain/core deprecates the constructor field, while
  // the message's own `additional_kwargs` stays where `denialCodeOf` and checkpointed messages read the code.
  message.additional_kwargs[DENIAL_KEY] = { code };
  return message;
}

/** The text of a rejection, with the approver's reason when there is one. */
export const rejectedText = (reason: string | undefined): string =>
  `The approver rejected this call${reason === undefined ? '' : `: ${reason}`}. ${NOT_RUN}`;

/**
 * What the model reads when the tool ran and its outcome record could not be written (`onRecordFailure:
 * 'tell-model'`). Fixed wording: no transport error text, no tool output, no id beyond the tool name. It says
 * the tool ran, so it is not a denial and does not carry `NOT_RUN`.
 */
export const unrecordedText = (toolName: string): string =>
  `The tool ${toolName} ran, but its outcome could not be recorded, so its result is withheld. Do not call ${toolName} again for this request: it already ran. Tell the user that this action was carried out and was not recorded, so that a person can follow up.`;
