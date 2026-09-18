export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE_URL = 'https://api.jup.ag/swap/v2';

const asAtomic = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) throw new Error('Swap amount must be a positive atomic-unit integer');
  return raw;
};

export class JupiterSwapClient {
  constructor({ apiKey, wallet }) {
    this.apiKey = String(apiKey ?? '').trim();
    this.wallet = wallet;
  }

  get configured() {
    return Boolean(this.apiKey && this.wallet?.configured);
  }

  async getOrder({ inputMint, outputMint, amount }) {
    if (!this.configured) throw new Error('Jupiter/Privy live execution is not configured');
    const params = new URLSearchParams({
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      amount: asAtomic(amount),
      taker: this.wallet.walletAddress
    });
    const response = await fetch(`${BASE_URL}/order?${params}`, {
      headers: { 'x-api-key': this.apiKey, accept: 'application/json' }
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`Jupiter /order HTTP ${response.status}: ${payload?.error ?? payload?.errorMessage ?? 'request failed'}`);
    }
    if (!payload?.transaction || !payload?.requestId) {
      const code = payload?.errorCode != null ? ` code=${payload.errorCode}` : '';
      throw new Error(`Jupiter could not build swap transaction${code}: ${payload?.errorMessage ?? 'no transaction'}`);
    }
    return payload;
  }

  async executeOrder(order) {
    if (!order?.transaction || !order?.requestId) throw new Error('Invalid Jupiter order');
    // Jupiter explicitly recommends partial signing: JupiterZ RFQ routes can add
    // the market-maker signature during /execute.
    const signedTransaction = await this.wallet.signTransaction(order.transaction);
    let response;
    let payload = null;
    try {
      response = await fetch(`${BASE_URL}/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          accept: 'application/json'
        },
        body: JSON.stringify({
          signedTransaction,
          requestId: order.requestId,
          ...(order.lastValidBlockHeight ? { lastValidBlockHeight: order.lastValidBlockHeight } : {})
        })
      });
      payload = await response.json().catch(() => null);
    } catch (cause) {
      const error = new Error(`Jupiter /execute transport failure: ${String(cause?.message ?? cause)}`, { cause });
      error.broadcastAttempted = true;
      error.requestId = order.requestId;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`Jupiter /execute HTTP ${response.status}: ${payload?.error ?? 'request failed'}`);
      error.broadcastAttempted = true;
      error.requestId = order.requestId;
      if (payload?.signature) error.signature = String(payload.signature);
      throw error;
    }
    if (payload?.status !== 'Success' || Number(payload?.code ?? 0) !== 0) {
      const error = new Error(`Jupiter swap failed code=${payload?.code ?? 'unknown'}: ${payload?.error ?? payload?.status ?? 'failed'}`);
      error.broadcastAttempted = true;
      error.requestId = order.requestId;
      if (payload?.signature) error.signature = String(payload.signature);
      throw error;
    }
    if (!payload?.signature) {
      const error = new Error('Jupiter reported success without a transaction signature');
      error.broadcastAttempted = true;
      error.requestId = order.requestId;
      throw error;
    }
    return payload;
  }

  async swap({ inputMint, outputMint, amount }) {
    const order = await this.getOrder({ inputMint, outputMint, amount });
    const result = await this.executeOrder(order);
    return {
      signature: String(result.signature),
      inputAmountAtomic: String(result.totalInputAmount ?? result.inputAmountResult ?? amount),
      outputAmountAtomic: String(result.totalOutputAmount ?? result.outputAmountResult ?? order.outAmount ?? '0'),
      router: order.router ?? null,
      mode: order.mode ?? null,
      feeBps: Number(order.feeBps ?? 0),
      feeMint: order.feeMint ?? null,
      requestId: order.requestId
    };
  }
}
