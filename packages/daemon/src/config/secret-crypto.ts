/**
 * Repo-facing wrapper around field-crypto (#331). Holds the resolved key
 * and centralises the graceful-failure contract (§3.5): a value that
 * can't be decrypted (wrong/lost key, tampering) is reported as "unset"
 * rather than crashing the daemon, so the operator re-enters it through
 * the wizard / Config and it re-encrypts under the current key.
 *
 * Legacy plaintext (pre-encryption, or an env/SOPS-sourced value) reads
 * straight through, which keeps upgrades and mixed sources working.
 */

import { encryptField, decryptField, isEncrypted } from './field-crypto.js';

/**
 * `secrets`-table columns to encrypt. Only true secrets - NOT the
 * dashboard password (already a one-way scrypt hash) and NOT the bitcoind
 * RPC url/user (connection identity, not secrets; keeping them readable
 * means a lost key doesn't sever the node connection, only the password
 * needs re-entry).
 */
export const SECRETS_ENCRYPTED_FIELDS = [
  'braiins_owner_token',
  'braiins_read_only_token',
  'bitcoind_rpc_password',
  'telegram_bot_token',
  'nicehash_api_key',
  'nicehash_api_secret',
] as const;

export class SecretCrypto {
  constructor(
    private readonly key: Buffer,
    private readonly log?: (msg: string) => void,
  ) {}

  /** Encrypt a plaintext value (idempotent - already-encrypted passes through). */
  encrypt(field: string, value: string): string {
    if (value === '' || isEncrypted(value)) return value;
    return encryptField(this.key, field, value);
  }

  /**
   * Decrypt a stored value. Plaintext (legacy / env / SOPS) reads
   * through. Returns null when an encrypted value can't be decrypted -
   * the caller treats null as "secret unavailable".
   */
  decrypt(field: string, stored: string): string | null {
    if (!isEncrypted(stored)) return stored;
    try {
      return decryptField(this.key, field, stored);
    } catch (err) {
      this.log?.(
        `[secret] could not decrypt "${field}" (wrong or lost key?); treating as unset: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** True when a stored value is already in the enc:v1: envelope. */
  isEncrypted(value: string): boolean {
    return isEncrypted(value);
  }
}
