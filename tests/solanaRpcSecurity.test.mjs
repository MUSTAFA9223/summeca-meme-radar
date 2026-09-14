import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMintSecurityAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from '../src/trading/solanaRpc.mjs';

const account = ({ owner = TOKEN_PROGRAM_ID, mintAuthority = null, freezeAuthority = null, extensions } = {}) => ({
  value: {
    owner,
    data: {
      parsed: {
        program: owner === TOKEN_2022_PROGRAM_ID ? 'spl-token-2022' : 'spl-token',
        type: 'mint',
        info: {
          mintAuthority,
          freezeAuthority,
          ...(extensions !== undefined ? { extensions } : {})
        }
      }
    }
  }
});

test('classic SPL mint with revoked mint/freeze authorities is verified on-chain', () => {
  const result = parseMintSecurityAccount(account());
  assert.equal(result.mintAuthorityDisabled, true);
  assert.equal(result.freezeAuthorityDisabled, true);
  assert.equal(result.isToken2022, false);
  assert.equal(result.onchainSecurityVerified, true);
  assert.equal(result.transferFeeEnable, false);
  assert.equal(result.nonTransferable, false);
});

test('classic SPL mint with active authority fails direct security verification', () => {
  const result = parseMintSecurityAccount(account({ mintAuthority: 'MintAuthority11111111111111111111111111111' }));
  assert.equal(result.mintAuthorityDisabled, false);
  assert.equal(result.onchainSecurityVerified, false);
});

test('Token-2022 with only harmless metadata extensions can be verified', () => {
  const result = parseMintSecurityAccount(account({
    owner: TOKEN_2022_PROGRAM_ID,
    extensions: [{ extension: 'metadataPointer' }, { extension: 'tokenMetadata' }]
  }));
  assert.equal(result.isToken2022, true);
  assert.equal(result.token2022ExtensionsVerified, true);
  assert.deepEqual(result.token2022UnsafeExtensions, []);
  assert.equal(result.onchainSecurityVerified, true);
});

test('Token-2022 transfer fee is treated as unsafe', () => {
  const result = parseMintSecurityAccount(account({
    owner: TOKEN_2022_PROGRAM_ID,
    extensions: [{ extension: 'transferFeeConfig' }]
  }));
  assert.equal(result.transferFeeEnable, true);
  assert.equal(result.onchainSecurityVerified, false);
  assert.deepEqual(result.token2022UnsafeExtensions, ['transferFeeConfig']);
});

test('Token-2022 permanent delegate is treated as unsafe', () => {
  const result = parseMintSecurityAccount(account({
    owner: TOKEN_2022_PROGRAM_ID,
    extensions: [{ extension: 'permanentDelegate' }]
  }));
  assert.equal(result.onchainSecurityVerified, false);
  assert.deepEqual(result.token2022UnsafeExtensions, ['permanentDelegate']);
});

test('Token-2022 without parsed extension evidence fails closed', () => {
  const result = parseMintSecurityAccount(account({ owner: TOKEN_2022_PROGRAM_ID }));
  assert.equal(result.token2022ExtensionsVerified, false);
  assert.equal(result.onchainSecurityVerified, false);
});
