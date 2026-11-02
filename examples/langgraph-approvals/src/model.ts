/** A chat model that plays a script, so the middleware variant needs no credentials. */
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

/** The n-th model turn is `script[n]`, then "Done." It reads the thread, so a re-run or a second process says the same thing. */
export class ScriptedModel extends BaseChatModel {
  readonly #script: readonly AIMessage[];

  constructor(script: readonly AIMessage[]) {
    super({});
    this.#script = script;
  }

  _llmType(): string {
    return 'scripted';
  }

  override bindTools(): this {
    return this;
  }

  _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const turn = messages.filter((m) => AIMessage.isInstance(m)).length;
    const message = this.#script[turn] ?? new AIMessage('Done.');
    return Promise.resolve({
      generations: [{ text: typeof message.content === 'string' ? message.content : '', message }],
    });
  }
}
