/** One JSON object per line on stdout: what each process says about itself, for the demo to read. */
export function say(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

/** A process's configuration, from its environment. */
export function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}
