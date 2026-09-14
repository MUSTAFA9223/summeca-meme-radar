import test from 'node:test';
import assert from 'node:assert/strict';
import { generateActivationCode, hashActivationCode } from '../src/storage/telegramAccess.mjs';

test('activation codes use the expected private SUMMECA format', () => {
  const code = generateActivationCode();
  assert.match(code, /^SMC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test('activation code hashing is normalized and deterministic', () => {
  const a = hashActivationCode('smc-abcd-2345');
  const b = hashActivationCode('  SMC-ABCD-2345  ');
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('different activation codes hash differently', () => {
  assert.notEqual(hashActivationCode('SMC-ABCD-2345'), hashActivationCode('SMC-ABCD-2346'));
});
