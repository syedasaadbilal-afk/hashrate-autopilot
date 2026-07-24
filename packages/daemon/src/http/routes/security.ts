/**
 * #332: in-app credential rotation for DB/wizard installs (Umbrel), where
 * there's no shell or SOPS to change the wizard-only secrets.
 *
 * - GET  /api/security/state          -> { secret_source, editable }
 * - POST /api/security/password        -> change the dashboard password (live)
 * - POST /api/security/braiins-token   -> rotate owner/read-only token (restart to apply)
 *
 * Every mutation requires the current dashboard password. Edits are
 * refused unless secrets are DB-sourced (env/SOPS would silently win on
 * next boot). New Braiins tokens are validated against Braiins before
 * they're committed, so a typo can't quietly disable order authorization.
 */

import type { FastifyInstance } from 'fastify';

import { createBraiinsClient } from '@hashrate-autopilot/braiins-client';

import { verifyPassword } from '../../config/password-hash.js';
import type { SecretsRepo } from '../../state/repos/secrets.js';

export interface SecurityRouteDeps {
  readonly secretsRepo: SecretsRepo;
  /** Where the running secrets came from - editing only makes sense for 'db'. */
  readonly secretSource: 'env' | 'sops' | 'db';
  /** Current stored dashboard password (hash or plaintext) for verification. */
  readonly getCurrentPassword: () => string;
  /** Hot-apply a new dashboard password to the live auth verifier + clear its cache. */
  readonly setDashboardPassword: (hashedOrPlain: string) => void;
  readonly log?: (msg: string) => void;
}

const MIN_PASSWORD_LEN = 8;

export async function registerSecurityRoutes(
  app: FastifyInstance,
  deps: SecurityRouteDeps,
): Promise<void> {
  const editable = deps.secretSource === 'db';

  app.get('/api/security/state', async () => ({
    secret_source: deps.secretSource,
    editable,
  }));

  app.post<{ Body: { current_password?: string; new_password?: string } }>(
    '/api/security/password',
    async (req, reply) => {
      if (!editable) {
        reply.code(409);
        return { error: 'managed_externally', secret_source: deps.secretSource };
      }
      const { current_password = '', new_password = '' } = req.body ?? {};
      if (!verifyPassword(current_password, deps.getCurrentPassword())) {
        reply.code(403);
        return { error: 'current password is incorrect' };
      }
      if (new_password.length < MIN_PASSWORD_LEN) {
        reply.code(422);
        return { error: `new password must be at least ${MIN_PASSWORD_LEN} characters` };
      }
      const hash = await deps.secretsRepo.setDashboardPassword(new_password);
      if (!hash) {
        reply.code(409);
        return { error: 'no stored secrets to update' };
      }
      // Hot-apply: point the live verifier at the same hash we just
      // stored. The new password works on the next request; the old one
      // stops immediately (which also boots anyone still using it).
      deps.setDashboardPassword(hash);
      deps.log?.('[security] dashboard password changed');
      return { ok: true };
    },
  );

  app.post<{
    Body: { kind?: 'owner' | 'read_only'; current_password?: string; token?: string };
  }>('/api/security/braiins-token', async (req, reply) => {
    if (!editable) {
      reply.code(409);
      return { error: 'managed_externally', secret_source: deps.secretSource };
    }
    const { kind = 'owner', current_password = '', token = '' } = req.body ?? {};
    if (kind !== 'owner' && kind !== 'read_only') {
      reply.code(422);
      return { error: 'kind must be "owner" or "read_only"' };
    }
    if (!verifyPassword(current_password, deps.getCurrentPassword())) {
      reply.code(403);
      return { error: 'current password is incorrect' };
    }
    if (token.trim().length === 0) {
      reply.code(422);
      return { error: 'token is required' };
    }
    // Validate against Braiins before committing - a typo/wrong token
    // would otherwise silently break bidding. Build a throwaway client
    // that uses ONLY the candidate token in the right role, and make a
    // lightweight authenticated read.
    const probe = createBraiinsClient(
      kind === 'owner' ? { ownerToken: token } : { readOnlyToken: token },
    );
    try {
      await probe.getBalance();
    } catch (err) {
      reply.code(422);
      return {
        error: 'Braiins rejected this token',
        detail: (err as Error).message,
      };
    }
    const ok = await deps.secretsRepo.setBraiinsToken(kind, token);
    if (!ok) {
      reply.code(409);
      return { error: 'no stored secrets to update' };
    }
    deps.log?.(`[security] braiins ${kind} token rotated (takes effect on restart)`);
    // Applied on restart - the running Braiins client keeps the old token
    // until then (documented in the UI).
    return { ok: true, applies_on_restart: true };
  });

  // #dual-provider: set/replace the three NiceHash API credentials. Same
  // guards as the Braiins rotation (db-sourced + current password). Stored
  // encrypted; the NiceHash client is built at boot, so this takes effect on
  // the next restart. Verify with a DRY-RUN order snapshot before going LIVE.
  app.post<{
    Body: {
      current_password?: string;
      org_id?: string;
      api_key?: string;
      api_secret?: string;
    };
  }>('/api/security/nicehash-keys', async (req, reply) => {
    if (!editable) {
      reply.code(409);
      return { error: 'managed_externally', secret_source: deps.secretSource };
    }
    const {
      current_password = '',
      org_id = '',
      api_key = '',
      api_secret = '',
    } = req.body ?? {};
    if (!verifyPassword(current_password, deps.getCurrentPassword())) {
      reply.code(403);
      return { error: 'current password is incorrect' };
    }
    if (org_id.trim().length === 0 || api_key.trim().length === 0 || api_secret.trim().length === 0) {
      reply.code(422);
      return { error: 'org id, api key and api secret are all required' };
    }
    const ok = await deps.secretsRepo.setNicehashCredentials(
      org_id.trim(),
      api_key.trim(),
      api_secret.trim(),
    );
    if (!ok) {
      reply.code(409);
      return { error: 'no stored secrets to update' };
    }
    deps.log?.('[security] nicehash credentials set (takes effect on restart)');
    return { ok: true, applies_on_restart: true };
  });
}
