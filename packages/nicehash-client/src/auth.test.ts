import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hasCredentials, signRequest } from './auth.js';

describe('signRequest', () => {
  const creds = { orgId: 'org-1', apiKey: 'key-1', apiSecret: 'secret-1' };
  const fixedNow = () => 1_700_000_000_000;

  it('produces the NiceHash header set', () => {
    const headers = signRequest(creds, 'GET', '/main/api/v2/hashpower/orderBook/', 'algorithm=SHA256', null, fixedNow);
    expect(headers['X-Time']).toBe('1700000000000');
    expect(headers['X-Organization-Id']).toBe('org-1');
    expect(headers['X-Auth'].startsWith('key-1:')).toBe(true);
    // hex digest after "key-1:"
    expect(headers['X-Auth'].slice('key-1:'.length)).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['X-Nonce']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('is deterministic for identical inputs (nonce held constant via a stubbed message)', () => {
    // signRequest generates a fresh random nonce each call, so two calls
    // won't produce identical signatures - assert instead that the same
    // *message* (reconstructed manually) yields the same digest as the
    // function produces, proving the byte layout is exactly the documented
    // apiKey\0xTime\0xNonce\0\0orgId\0\0method\0path\0query scheme.
    const headers = signRequest(creds, 'GET', '/p', 'q=1', null, fixedNow);
    const message = [
      creds.apiKey,
      '1700000000000',
      headers['X-Nonce'],
      '',
      creds.orgId,
      '',
      'GET',
      '/p',
      'q=1',
    ].join('\x00');
    const expectedDigest = createHmac('sha256', creds.apiSecret).update(message, 'utf8').digest('hex');
    expect(headers['X-Auth']).toBe(`key-1:${expectedDigest}`);
  });

  it('includes the body in the signed message when present', () => {
    const bodyStr = JSON.stringify({ a: 1 });
    const headers = signRequest(creds, 'POST', '/p', '', bodyStr, fixedNow);
    const message = [
      creds.apiKey,
      '1700000000000',
      headers['X-Nonce'],
      '',
      creds.orgId,
      '',
      'POST',
      '/p',
      '',
      bodyStr,
    ].join('\x00');
    const expectedDigest = createHmac('sha256', creds.apiSecret).update(message, 'utf8').digest('hex');
    expect(headers['X-Auth']).toBe(`key-1:${expectedDigest}`);
  });
});

describe('hasCredentials', () => {
  it('requires all three fields', () => {
    expect(hasCredentials({})).toBe(false);
    expect(hasCredentials({ orgId: 'o' })).toBe(false);
    expect(hasCredentials({ orgId: 'o', apiKey: 'k' })).toBe(false);
    expect(hasCredentials({ orgId: 'o', apiKey: 'k', apiSecret: 's' })).toBe(true);
  });
});
