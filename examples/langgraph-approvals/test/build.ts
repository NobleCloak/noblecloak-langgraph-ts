/** Builds the entry points the end-to-end test starts as processes. */
import { build } from 'tsup';

export default async function setup(): Promise<void> {
  await build({ config: 'tsup.config.ts', silent: true });
}
