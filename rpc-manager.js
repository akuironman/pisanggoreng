// ============================================
// PISANGGORENG v2.2 — RPC MANAGER
// Multi-endpoint rotation + rate-limit handling
// ============================================
const solanaWeb3 = require('@solana/web3.js');

class RpcManager {
  constructor(config) {
    // Priority: custom RPC > Helius > QuickNode > public fallback
    this.endpoints = [
      { url: config.rpcEndpoint, ws: config.rpcWs },                    // User's custom
      { url: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com' },
    ];

    // Check for Helius API key in env
    if (config.heliusApiKey) {
      this.endpoints.unshift({
        url: `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        ws: `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
      });
    }

    // Current index
    this.currentIndex = 0;
    this.connections = [];
    this.lastUsed = {};
    this.rateLimitUntil = {};
    this.retryCount = {};

    // Build connections
    this._buildConnections();
  }

  _buildConnections() {
    this.connections = this.endpoints.map((ep, i) => ({
      index: i,
      url: ep.url,
      ws: ep.ws,
      connection: new solanaWeb3.Connection(ep.url, {
        wsEndpoint: ep.ws,
        commitment: 'confirmed',  // Changed to confirmed to fix polling error
        confirmTransactionInitialTimeout: 60000,
      }),
    }));
  }

  /**
   * Get current active connection
   */
  getConnection() {
    return this.connections[this.currentIndex].connection;
  }

  /**
   * Rotate to next available RPC endpoint
   */
  rotate() {
    const oldIdx = this.currentIndex;
    this.currentIndex = (this.currentIndex + 1) % this.connections.length;

    // Reset rate-limit for new endpoint after 10s
    setTimeout(() => {
      this.retryCount[this.connections[this.currentIndex].url] = 0;
    }, 10000);

    console.log(`[RPC] 🔄 Rotated: ${this.connections[oldIdx].url.slice(0, 40)}... → ${this.connections[this.currentIndex].url.slice(0, 40)}...`);
    return this.getConnection();
  }

  /**
   * Execute a call with automatic retry + rotation on 429
   */
  async call(methodName, fn, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const conn = this.getConnection();
        const result = await fn(conn);

        // Success — reset retry count for this endpoint
        this.retryCount[conn.rpcEndpoint] = 0;
        return result;

      } catch (e) {
        const msg = e.message || String(e);

        // Rate limited — rotate
        if (msg.includes('429') || msg.includes('Too Many Requests') || msg.includes('rate limit')) {
          const connUrl = this.getConnection().rpcEndpoint;
          this.retryCount[connUrl] = (this.retryCount[connUrl] || 0) + 1;

          if (this.retryCount[connUrl] >= 2) {
            console.warn(`[RPC] ⚠️ Rate limited on ${connUrl.slice(0, 40)}... rotating`);
            this.rotate();
          } else {
            // Short backoff
            const wait = Math.min(1000 * (attempt + 1), 4000);
            console.warn(`[RPC] ⏳ Rate limited, waiting ${wait}ms... (attempt ${attempt + 1}/${retries})`);
            await new Promise(r => setTimeout(r, wait));
          }
          continue;
        }

        // Connection error — rotate immediately (but NOT "account not found")
        if ((msg.includes('fetch failed') || msg.includes('socket') || msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) &&
            !msg.includes('account') && !msg.includes('Account')) {
          console.warn(`[RPC] 🔌 Connection error: ${msg.slice(0, 60)}... rotating`);
          this.rotate();
          continue;
        }

        // "Account not found" or similar — just throw normally
        if (msg.includes('failed to get info about account') || msg.includes('account not found') || msg.includes('AccountNotFound')) {
          throw e; // Normal RPC error, not connection issue
        }

        // Non-recoverable — throw
        throw e;
      }
    }

    throw new Error(`RPC call '${methodName}' failed after ${retries} attempts`);
  }

  /**
   * Get SOL balance with auto-retry
   */
  async getBalance(publicKey) {
    return this.call('getBalance', (conn) => conn.getBalance(publicKey));
  }

  /**
   * Get token account balance with auto-retry
   */
  async getTokenAccountBalance(tokenAccount) {
    return this.call('getTokenAccountBalance', (conn) => conn.getTokenAccountBalance(tokenAccount));
  }

  /**
   * Get account info with auto-retry
   */
  async getAccountInfo(pubkey) {
    return this.call('getAccountInfo', (conn) => conn.getAccountInfo(pubkey));
  }

  /**
   * Get transaction with auto-retry
   */
  async getTransaction(sig, opts) {
    return this.call('getTransaction', (conn) => conn.getTransaction(sig, opts));
  }

  /**
   * Get signatures for address with auto-retry
   */
  async getSignaturesForAddress(address, opts) {
    return this.call('getSignaturesForAddress', (conn) => conn.getSignaturesForAddress(address, opts));
  }

  /**
   * Get latest blockhash with auto-retry
   */
  async getLatestBlockhash(commitment) {
    return this.call('getLatestBlockhash', (conn) => conn.getLatestBlockhash(commitment));
  }

  /**
   * Send transaction with auto-retry
   */
  async sendTransaction(tx, opts) {
    return this.call('sendTransaction', (conn) => conn.sendTransaction(tx, opts));
  }

  /**
   * Confirm transaction with auto-retry
   */
  async confirmTransaction(confirmation, commitment) {
    return this.call('confirmTransaction', (conn) => conn.confirmTransaction(confirmation, commitment));
  }

  /**
   * Subscribe to program logs (always uses the first/primary WS endpoint)
   * Returns the subscription ID
   */
  onLogs(programId, callback, commitment) {
    // Use the primary connection for WS
    const primaryConn = this.connections[0].connection;
    return primaryConn.onLogs(programId, callback, commitment);
  }

  /**
   * Remove logs subscription
   */
  removeOnLogs(subscriptionId) {
    const primaryConn = this.connections[0].connection;
    primaryConn.removeOnLogs(subscriptionId);
  }
}

module.exports = RpcManager;
