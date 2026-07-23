/**
 * HMAC-SHA256 request signing for the NiceHash API v2.
 *
 * Unlike Braiins' single `apikey:` header, NiceHash requires every
 * authenticated call to carry a signature over the request's method, path,
 * query string, and (for mutations) body - see NiceHash's own reference
 * client (https://github.com/nicehash/rest-clients-demo/blob/master/python/nicehash.py):
 *
 *   message = apiKey \0 xTime \0 xNonce \0 \0 orgId \0 \0 method \0 path \0 query [\0 body]
 *   digest  = HMAC-SHA256(apiSecret, message)  (hex)
 *   X-Auth  = apiKey + ":" + digest
 *
 * The two empty segments (after xNonce and after orgId) are not typos -
 * they're reserved slots in NiceHash's own scheme; byte-for-byte parity
 * with the reference client matters here since a single wrong separator
 * produces a signature that fails silently (401, no further detail).
 */

import { createHmac, randomUUID } from 'node:crypto';

export interface NiceHashCredentials {
  readonly orgId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface SignedHeaders {
  readonly 'X-Time': string;
  readonly 'X-Nonce': string;
  readonly 'X-Auth': string;
  readonly 'X-Organization-Id': string;
  readonly 'X-Request-Id': string;
  readonly 'Content-Type': string;
}

/**
 * Build the signed header set for one request. `body` is the exact JSON
 * string that will be sent (or null for bodyless requests) - it must be
 * byte-identical to what actually goes over the wire, since it's part of
 * the signed message.
 */
export function signRequest(
  creds: NiceHashCredentials,
  method: string,
  path: string,
  query: string,
  body: string | null,
  now: () => number = Date.now,
): SignedHeaders {
  const xTime = now();
  const xNonce = randomUUID();

  const parts = [
    creds.apiKey,
    String(xTime),
    xNonce,
    '', // reserved
    creds.orgId,
    '', // reserved
    method,
    path,
    query,
  ];
  if (body !== null) parts.push(body);

  const message = parts.join('\x00');
  const digest = createHmac('sha256', creds.apiSecret).update(message, 'utf8').digest('hex');

  return {
    'X-Time': String(xTime),
    'X-Nonce': xNonce,
    'X-Auth': `${creds.apiKey}:${digest}`,
    'X-Organization-Id': creds.orgId,
    'X-Request-Id': randomUUID(),
    'Content-Type': 'application/json',
  };
}

export interface MaybeNiceHashCredentials {
  readonly orgId?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly apiSecret?: string | undefined;
}

export function hasCredentials(creds: MaybeNiceHashCredentials): creds is NiceHashCredentials {
  return Boolean(creds.orgId && creds.apiKey && creds.apiSecret);
}
