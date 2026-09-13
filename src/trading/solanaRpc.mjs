export class SolanaRpcClient {
  constructor({ heliusApiKey }) {
    this.apiKey = String(heliusApiKey ?? '').trim();
    this.endpoint = this.apiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(this.apiKey)}`
      : 'https://api.mainnet-beta.solana.com';
  }

  async rpc(method, params = []) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Solana RPC ${method} HTTP ${response.status}`);
    if (payload?.error) throw new Error(`Solana RPC ${method}: ${payload.error.message ?? JSON.stringify(payload.error)}`);
    return payload?.result;
  }

  async getSolBalanceLamports(address) {
    const result = await this.rpc('getBalance', [address, { commitment: 'confirmed' }]);
    return BigInt(result?.value ?? 0);
  }

  async getTokenBalanceAtomic(owner, mint) {
    const result = await this.rpc('getTokenAccountsByOwner', [
      owner,
      { mint },
      { encoding: 'jsonParsed', commitment: 'confirmed' }
    ]);
    let total = 0n;
    for (const item of result?.value ?? []) {
      const amount = item?.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (/^\d+$/.test(String(amount ?? ''))) total += BigInt(amount);
    }
    return total;
  }

  async sendSignedTransaction(signedBase64) {
    const signature = await this.rpc('sendTransaction', [signedBase64, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3
    }]);
    if (!signature) throw new Error('Solana RPC returned no transaction signature');
    return String(signature);
  }

  async waitForSignature(signature, { timeoutMs = 45_000, pollMs = 1200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = result?.value?.[0];
      if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return status;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Transaction confirmation timed out: ${signature}`);
  }
}
