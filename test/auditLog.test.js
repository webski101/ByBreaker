// test/auditLog.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../src/auditLog.js';

describe('AuditLog: in-memory chain', () => {
  test('each entry chains to the previous hash', () => {
    const log = new AuditLog({});
    log.append({ type: 'A', description: 'first' });
    log.append({ type: 'B', description: 'second' });
    assert.equal(log.entries[1].prevHash, log.entries[0].hash);
  });

  test('verify() passes on an untouched chain', () => {
    const log = new AuditLog({});
    log.append({ type: 'A' });
    log.append({ type: 'B' });
    log.append({ type: 'C' });
    assert.deepEqual(log.verify(), { ok: true, brokenAt: null, entries: 3 });
  });

  test('verify() detects a mutated field', () => {
    const log = new AuditLog({});
    log.append({ type: 'A', description: 'original' });
    log.append({ type: 'B' });
    log.entries[0].description = 'tampered'; // edit history after the fact
    const result = log.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
  });

  test('verify() detects a deleted entry (chain gap)', () => {
    const log = new AuditLog({});
    log.append({ type: 'A' });
    log.append({ type: 'B' });
    log.append({ type: 'C' });
    log.entries.splice(1, 1); // remove the middle entry
    const result = log.verify();
    assert.equal(result.ok, false);
  });
});

describe('AuditLog: file persistence', () => {
  test('writes JSONL and resumes the chain correctly on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-compiler-test-'));
    const filePath = join(dir, 'audit.jsonl');
    try {
      const log1 = new AuditLog({ filePath });
      log1.append({ type: 'A' });
      log1.append({ type: 'B' });

      const log2 = new AuditLog({ filePath }); // reopen
      log2.append({ type: 'C' });

      assert.equal(log2.entries.length, 3);
      assert.equal(log2.entries[2].prevHash, log2.entries[1].hash);
      assert.equal(AuditLog.verifyFile(filePath).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('verifyFile() catches tampering with the file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-compiler-test-'));
    const filePath = join(dir, 'audit.jsonl');
    try {
      const log = new AuditLog({ filePath });
      log.append({ type: 'A', observed: 0.1 });
      log.append({ type: 'B', observed: 0.2 });

      const lines = readFileSync(filePath, 'utf8').trim().split('\n');
      const tampered = JSON.parse(lines[0]);
      tampered.observed = 999; // attacker edits a past reading
      lines[0] = JSON.stringify(tampered);
      writeFileSync(filePath, lines.join('\n') + '\n');

      assert.equal(AuditLog.verifyFile(filePath).ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
