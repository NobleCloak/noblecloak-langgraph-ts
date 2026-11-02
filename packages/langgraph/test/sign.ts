/** A signing key of the test's own, so a test can mint a validly signed Resumption the mock would never issue. */
import { jcs } from '@noblecloak/client';
import type { Jwks, JsonValue } from '@noblecloak/client';

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export interface TestSigner {
  readonly jwks: Jwks;
  /** A JWS compact serialization of `payload`: ES256, the key's `kid` in the header, JCS payload. */
  sign(payload: Record<string, unknown>): Promise<string>;
}

export async function createSigner(kid = 'test-key'): Promise<TestSigner> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y), kid }] },
    async sign(payload) {
      const header = base64Url(encoder.encode(JSON.stringify({ alg: 'ES256', kid })));
      const body = base64Url(encoder.encode(jcs(payload as JsonValue)));
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        encoder.encode(`${header}.${body}`)
      );
      return `${header}.${body}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}
