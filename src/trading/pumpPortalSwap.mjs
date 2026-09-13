const LOCAL_TRADE_URL = 'https://pumpportal.fun/api/trade-local';

export class PumpPortalSwapClient {
  constructor({ wallet, rpc, slippagePct = 10, priorityFeeSol = 0.00005 }) {
    this.wallet = wallet;
    this.rpc = rpc;
    this.slippagePct = Math.max(1, Math.min(15, Number(slippagePct) || 10));
    this.priorityFeeSol = Math.max(0, Math.min(0.005, Number(priorityFeeSol) || 0.00005));
  }

  get configured() {
    return Boolean(this.wallet?.configured && this.rpc);
  }

  async #build({ action, mint, amount, denominatedInSol }) {
    if (!this.configured) throw new Error('PumpPortal/Privy live execution is not configured');
    const response = await fetch(LOCAL_TRADE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/octet-stream' },
      body: JSON.stringify({
        publicKey: this.wallet.walletAddress,
        action,
        mint,
        amount,
        denominatedInSol: denominatedInSol ? 'true' : 'false',
        slippage: this.slippagePct,
        priorityFee: this.priorityFeeSol,
        pool: 'auto'
      })
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`PumpPortal trade-local HTTP ${response.status}${message ? `: ${message.slice(0, 180)}` : ''}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('PumpPortal returned an empty transaction');
    return bytes.toString('base64');
  }

  async #signSend(transactionBase64) {
    const signedTransaction = await this.wallet.signTransaction(transactionBase64);
    const signature = await this.rpc.sendSignedTransaction(signedTransaction);
    await this.rpc.waitForSignature(signature);
    return signature;
  }

  async buy({ mint, solAmount }) {
    const amount = Number(solAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid SOL buy amount');
    const tx = await this.#build({ action: 'buy', mint, amount, denominatedInSol: true });
    const signature = await this.#signSend(tx);
    return { signature, venue: 'pumpportal', inputSol: amount };
  }

  async sell({ mint }) {
    // PumpPortal explicitly supports percentage sells. The trading wallet is
    // dedicated to SUMMECA, so 100% avoids token-decimal/atomic-unit ambiguity.
    const tx = await this.#build({ action: 'sell', mint, amount: '100%', denominatedInSol: false });
    const signature = await this.#signSend(tx);
    return { signature, venue: 'pumpportal' };
  }
}
