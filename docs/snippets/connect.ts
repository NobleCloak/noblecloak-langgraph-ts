import { createClient } from '@noblecloak/client';

export const baseUrl = process.env.NC_BASE_URL ?? 'http://127.0.0.1:8787';

// The mock serves its dev tokens here. A real deployment has no /__mock/* routes.
const tokens = (await (await fetch(`${baseUrl}/__mock/tokens`)).json()) as Record<string, string>;

export function token(name: 'creator' | 'approver'): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`the mock served no ${name} token`);
  return value;
}

// The agent: a service principal with the module_api scope.
export const creator = createClient({ baseUrl, getToken: () => token('creator') });

// A person: a user principal with the approvals:resolve scope.
export const approver = createClient({ baseUrl, getToken: () => token('approver') });
