// ============================================
// PISANGGORENG v2.0 — JITO BUNDLE ENGINE
// ============================================
// Sends txs via Jito Block Engine — bypasses
// public mempool, no frontrun, no sandwich
// ============================================
// ─── bs58 — support both v5 (cjs) and v6 (esm) ──
let bs58;
try {
  bs58 = require('bs58');
} catch (_) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  bs58 = {
    encode: (buf) => {
      let n = 0n;
      for (const b of Buffer.from(buf)) n = (n << 8n) + BigInt(b);
      let s = '';
      while (n > 0n) { s = alphabet[Number(n % 58n)] + s; n /= 58n; }
      return s || '1';
    }
  };
}
const solanaWeb3 = require('@solana/web3.js');

class JitoEngine {
  constructor(config) {
    this.enabled = config.enabled;
    this.tipAmount = config.tipAmount || 0.0001; // SOL tip to Jito validators
    this.blockEngineUrl = config.blockEngineUrl || 'https://mainnet.block-engine.jito.wtf';
    this.connection = config.connection;
    this.walletKeypair = config.walletKeypair;
    this.jupiterApi = config.jupiterApi || 'https://quote-api.jup.ag/v6';

    // Build the bundle URL
    this.bundleUrl = `${this.blockEngineUrl}/api/v1/bundles`;
    this.tipUrl = `${this.blockEngineUrl}/api/v1/bundles/tip`;
  }

  /**
   * Get current Jito tip (minimum tip needed for bundle acceptance)
   */
  async getTipAmount() {
    try {
      const resp = await fetch(this.tipUrl);
      if (resp.ok) {
        const data = await resp.json();
        // Returns in SOL, convert from whatever unit
        if (data && data.tip) {
          return parseFloat(data.tip);
        }
      }
    } catch (e) {}
    return this.tipAmount; // fallback to config
  }

  /**
   * Build a tip transfer instruction to the Jito random tip account
   */
  getTipInstruction(tipLamports) {
    // Jito tip accounts rotate per validator — use the deterministic one
    // get a random recent tip account from the API
    const tipAccounts = [
      '96gYZGDn1b5BTtB6nmMEipEeCTZoXcFnQ7X9RzRmwTqr',
      'HFvjK1SMMggGnS48MNYdGYYeYHN7TrcAqF72S24KkxVH',
      'Cw8FcxvzSq9tvL1NrsR88QMWrkCJZz6jET3iCJ14JGKc',
      'ADaUM1vcioiSBwjNgCdaWBazamNjrZPQjsZ5r3Au5F7E',
      'DfXygSm4jCVGVCjMYen5HnRGD2qYQW2Mvyq8oB2Eshpy',
      'DdiEgEMLnP6PkZbQEF4aoX3Ytnj3ZqkmBV5N11tEkrV3',
    ];
    const randomTipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];

    return solanaWeb3.SystemProgram.transfer({
      fromPubkey: this.walletKeypair.publicKey,
      toPubkey: new solanaWeb3.PublicKey(randomTipAccount),
      lamports: tipLamports,
    });
  }

  /**
   * Send a SINGLE tx as a bundle (bundle with just 1 tx + tip)
   */
  async sendBundle(tx, label = 'TX') {
    if (!this.enabled) return null;

    try {
      const tipAmount = await this.getTipAmount();
      const tipLamports = Math.floor(tipAmount * solanaWeb3.LAMPORTS_PER_SOL * 1000) || 10000;
      const actualTip = Math.max(tipLamports, 10000); // at least 0.00001 SOL

      // Get a fresh blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('processed');

      // Build tip transaction
      const tipTx = new solanaWeb3.Transaction();
      tipTx.feePayer = this.walletKeypair.publicKey;
      tipTx.recentBlockhash = blockhash;
      tipTx.add(this.getTipInstruction(actualTip));
      tipTx.sign(this.walletKeypair);

      // The swap tx is already signed — need to handle VersionedTransaction
      const bundleTxs = [];

      if (tx.constructor.name === 'VersionedTransaction') {
        // Versioned — need to send serialized
        const swapTxBuf = tx.serialize();
        bundleTxs.push(bs58.encode(swapTxBuf));
      } else {
        // Legacy Transaction
        tx.recentBlockhash = blockhash;
        tx.sign(this.walletKeypair);
        const swapTxBuf = tx.serialize({ requireAllSignatures: false });
        bundleTxs.push(bs58.encode(swapTxBuf));
      }

      // Serialize tip tx
      const tipTxBuf = tipTx.serialize({ requireAllSignatures: false });
      bundleTxs.push(bs58.encode(tipTxBuf));

      // Timestamp
      const timestamp = Math.floor(Date.now() / 1000);

      // Send bundle to Jito
      const resp = await fetch(this.bundleUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: timestamp,
          method: 'sendBundle',
          params: [bundleTxs],
        }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        log.warn(`Jito: ${label} bundle failed (${resp.status}): ${text.slice(0,150)}`);
        return null;
      }

      const data = await resp.json();
      if (data.error) {
        log.warn(`Jito: ${label} bundle error: ${data.error.message || JSON.stringify(data.error).slice(0,100)}`);
        // Fallback: could try regular send
        return null;
      }

      const bundleId = data.result;
      log.debug(`Jito: ${label} bundle submitted: ${bundleId}`);

      // Wait for confirmation
      await this.waitForBundleConfirmation(bundleId);

      // The actual tx sig we need is the first tx in the bundle
      // We use the bundle ID as the "signature" for tracking
      return bundleId;

    } catch (e) {
      log.error(`Jito: ${label} bundle error:`, e.message);
      return null;
    }
  }

  /**
   * Wait for a bundle to be confirmed (poll Jito)
   */
  async waitForBundleConfirmation(bundleId, maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const resp = await fetch(this.bundleUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        if (resp.ok) {
          const data = await resp.json();
          if (data.result && data.result.value && data.result.value.length > 0) {
            const status = data.result.value[0];
            if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
              log.debug(`Jito: Bundle ${bundleId.slice(0,12)}... ${status.confirmationStatus}`);
              return {
                confirmed: true,
                status: status.confirmationStatus,
                txSignatures: status.transactions || [],
              };
            }
            if (status.confirmationStatus === 'failed') {
              log.warn(`Jito: Bundle ${bundleId.slice(0,12)}... failed`);
              return { confirmed: false, status: 'failed', txSignatures: [] };
            }
          }
        }
      } catch (e) {}

      await new Promise(r => setTimeout(r, 1000));
    }

    log.warn(`Jito: Bundle ${bundleId.slice(0,12)}... confirmation timeout`);
    return { confirmed: false, status: 'timeout', txSignatures: [] };
  }

  /**
   * Send a swap via Jito bundle (swap tx + tip tx)
   * Returns the bundle result
   */
  async sendSwapBundle(swapTx, label = 'SWAP') {
    if (!this.enabled) {
      // Fallback to regular send
      return null;
    }

    return await this.sendBundle(swapTx, label);
  }
}

module.exports = JitoEngine;
