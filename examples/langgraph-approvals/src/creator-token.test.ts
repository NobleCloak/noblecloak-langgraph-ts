import { describe, expect, it } from 'vitest';

import { creatorGetToken } from './creator-token.js';

const CLIENT_ID = 'sp_0b8d1d6e-5c53-4b8e-9d3a-2f6f7a1c9e10';

async function credentialJson(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return JSON.stringify({
    client_id: CLIENT_ID,
    token_endpoint: 'https://api.example.test/auth/oauth/token',
    assertion_audience: 'https://api.example.test',
    private_jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  });
}

function stub() {
  const forms: URLSearchParams[] = [];
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    forms.push(new URLSearchParams(await new Request(input, init).text()));
    return Response.json({ access_token: 'minted', token_type: 'Bearer', expires_in: 600 });
  };
  return { forms, fetch: fetchStub };
}

describe('creatorGetToken', () => {
  it('returns NC_TOKEN as is when set, even if a credential is also set', async () => {
    const endpoint = stub();
    const getToken = await creatorGetToken({
      env: { NC_TOKEN: 'pasted', NOBLECLOAK_SP_CREDENTIALS: await credentialJson() },
      fetch: endpoint.fetch,
    });
    expect(await getToken()).toBe('pasted');
    expect(endpoint.forms).toHaveLength(0);
  });

  it('mints from the credential, for the API origin as the resource', async () => {
    const endpoint = stub();
    const getToken = await creatorGetToken({
      env: {
        NOBLECLOAK_SP_CREDENTIALS: await credentialJson(),
        NC_BASE_URL: 'https://govern.example.test/some/path',
      },
      fetch: endpoint.fetch,
    });
    expect(await getToken()).toBe('minted');
    expect(await getToken()).toBe('minted');
    expect(endpoint.forms).toHaveLength(1);
    expect(endpoint.forms[0]?.get('resource')).toBe('https://govern.example.test');
    expect(endpoint.forms[0]?.get('client_id')).toBe(CLIENT_ID);
  });

  it('lets NC_AUDIENCE override the resource', async () => {
    const endpoint = stub();
    const getToken = await creatorGetToken({
      env: {
        NOBLECLOAK_SP_CREDENTIALS: await credentialJson(),
        NC_BASE_URL: 'https://govern.example.test',
        NC_AUDIENCE: 'https://mcp-agents.example.test',
      },
      fetch: endpoint.fetch,
    });
    await getToken();
    expect(endpoint.forms[0]?.get('resource')).toBe('https://mcp-agents.example.test');
  });

  it('names both variables when neither is set, and NC_BASE_URL when a credential has no base URL', async () => {
    await expect(creatorGetToken({ env: {} })).rejects.toThrow(
      /NOBLECLOAK_SP_CREDENTIALS.*NC_TOKEN/
    );
    await expect(
      creatorGetToken({ env: { NOBLECLOAK_SP_CREDENTIALS: await credentialJson() } })
    ).rejects.toThrow(/NC_BASE_URL/);
  });
});
