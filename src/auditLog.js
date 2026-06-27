// src/auditLog.js
//
// Every time the enforcer trips a rule (or the system starts/stops), it
// writes one line here. Each line's hash is derived from its own contents
// PLUS the previous line's hash, so editing or deleting a past entry breaks
// every hash after it. This doesn't require a blockchain or any external
// service — it's the same construction used by git commits and is enough
// to make tampering mathematically detectable by anyone re-running verify().

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, writeFileSync } from 'node:fs';

const GENESIS_HASH = '0'.repeat(64);

function sha256(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

export class AuditLog {
  /** @param {{ filePath?: string }} opts */
  constructor({ filePath } = {}) {
    this.filePath = filePath ?? null;
    this.entries = [];

    if (this.filePath && existsSync(this.filePath)) {
      // Resume an existing chain rather than overwrite it.
      this.entries = AuditLog.readFile(this.filePath);
    } else if (this.filePath) {
      writeFileSync(this.filePath, '');
    }
  }

  get lastHash() {
    return this.entries.length === 0
      ? GENESIS_HASH
      : this.entries[this.entries.length - 1].hash;
  }

  /**
   * Append a new entry. `fields` should NOT include seq/timestamp/prevHash/
   * hash — those are computed here so a caller can never forge them.
   */
  append(fields) {
    const seq = this.entries.length + 1;
    const timestamp = fields.timestamp ?? new Date().toISOString();
    const prevHash = this.lastHash;
    const base = { seq, timestamp, ...fields, prevHash };
    const hash = sha256(base);
    const entry = { ...base, hash };

    this.entries.push(entry);
    if (this.filePath) {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n');
    }
    return entry;
  }

  /** Re-derive every hash and confirm the chain hasn't been altered. */
  verify() {
    let prevHash = GENESIS_HASH;
    for (let i = 0; i < this.entries.length; i++) {
      const { hash, ...rest } = this.entries[i];
      if (rest.prevHash !== prevHash) {
        return { ok: false, brokenAt: i, reason: 'prevHash mismatch' };
      }
      const recomputed = sha256(rest);
      if (recomputed !== hash) {
        return { ok: false, brokenAt: i, reason: 'hash mismatch' };
      }
      prevHash = hash;
    }
    return { ok: true, brokenAt: null, entries: this.entries.length };
  }

  static readFile(filePath) {
    const raw = readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  static verifyFile(filePath) {
    const entries = AuditLog.readFile(filePath);
    const log = new AuditLog({});
    log.entries = entries;
    return log.verify();
  }
}
