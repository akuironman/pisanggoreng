// ============================================
// PISANGGORENG v2.3 — RPC MANAGER
// Multi-endpoint pool + smart rotation + 429 backoff
// ============================================
const solanaWeb3 = require('@solana/web3.js');

class RpcManager {
  constructor(config) {
    this.endpoints = [];

    // 1) Helius (paid) — highest priority if API key present
    if (config.heliusApiKey) {
      this.endpoints.push({
        url: `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        ws: `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`,
        label: 'helius',
      });
    }

    // 2) User's custom RPC(s) — support comma-separated list in RPC_ENDPOINT
    if (config.rpcEndpoint) {
      const urls = config.rpcEndpoint.split(',').map(s => s.trim()).filter(Boolean);
      const wss = (config.rpcWs || '').split(',').map(s => s.trim()).filter(Boolean);
      urls.forEach((url, i) => {
        // Skip if it's literally the public endpoint (we add it below as last resort)
        if (url.includes('api.mainnet-beta.solana.com')) return;
        this.endpoints.push({
          url,
          ws: wss[i] || url.replace(/^http/, 'ws'),
          label: `custom-${i}`,
        });
      });
    }

    // 3) Free public fallbacks (LAST resort — very strict rate limits)
    const FREE_FALLBACKS = [
      { url: 'https://api.mainnet-beta.solana.com', ws: 'wss://api.mainnet-beta.solana.com', label: 'solana-public' },
      { url: 'https://rpc.ankr.com/solana', ws: 'wss://rpc.ankr.com/solana/ws', label: 'ankr' },
    ];
    // Dedupe — don't add same URL twice
    const seen = new Set(this.endpoints.map(e => e.url));
    for (const fb of FREE_FALLBACKS) {
      if (!seen.has(fb.url)) this.endpoints.push(fb);
    }

    if (this.endpoints.length === 0) {
      // Absolute last resort
      this.endpoints.push(FREE_FALLBACKS[0]);
    }

    this.currentIndex = 0;
    this.connections = [];
    this.rateLimitUntil = {};   // url -> timestamp until which endpoint is blocked
    this.consecutive429 = {};   // url -> count

    this._buildConnections();

    const labels = this.endpoints.map(e => e.label).join(', ');
    console.log(`[RPC] 📡 Pool: ${this.endpoints.length} endpoint(s) [${labels}]`);
  }

  _buildConnections() {
    this.connections = this.endpoints.map((ep, i) => ({
      index: i,
      url: ep.url,
      ws: ep.ws,
      label: ep.label,
      connection: new solanaWeb3.Connection(ep.url, {
        wsEndpoint: ep.ws,
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        // Throttle our own request rate on public endpoints
        disableRetryOnRateLimit: false,
      }),
    }));
  }

  /**
   * Pick the best available connection (skip rate-limited ones)
   */
  _pickAvailable() {
    const now = Date.now();
    // Try current first
    for (let offset = 0; offset < this.connections.length; offset++) {
      const idx = (this.currentIndex + offset) % this.connections.length;
      const conn = this.connections[idx];
      const blockedUntil = this.rateLimitUntil[conn.url] || 0;
      if (now >= blockedUntil) {
        this.currentIndex = idx;
        return conn;
      }
    }
    // All blocked — return current (least bad), with shortest remaining wait
    return this.connections[this.currentIndex];
  }

  getConnection() {
    return this._pickAvailable().connection;
  }

  /**
   * Mark an endpoint as rate-limited and rotate to next available
   */
  _markRateLimited(url) {
    this.consecutive429[url] = (this.consecutive429[url] || 0) + 1;
    // Exponential backoff: 5s, 15s, 30s
    const backoff = Math.min(5000 * Math.pow(2, this.consecutive429[url] - 1), 30000);
    this.rateLimitUntil[url] = Date.now() + backoff;
    const idx = this.connections.findIndex(c => c.url === url);
    const label = idx >= 0 ? this.connections[idx].label : url.slice(0, 30);
    console.warn(`[RPC] ⛔ ${label} rate-limited — cooling down ${backoff}ms, rotating`);

    // Rotate to next available
    const now = Date.now();
    for (let i = 0; i < this.connections.length; i++) {
      const nextIdx = (this.currentIndex + 1 + i) % this.connections.length;
      const c = this.connections[nextIdx];
      if (now >= (this.rateLimitUntil[c.url] || 0)) {
        if (nextIdx !== this.currentIndex) {
          const oldLabel = this.connections[this.currentIndex].label;
          this.currentIndex = nextIdx;
          console.log(`[RPC] 🔄 Rotated: ${oldLabel} → ${c.label}`);
        }
        break;
      }
    }
  }

  _markHealthy(url) {
    this.consecutive429[url] = 0;
    delete this.rateLimitUntil[url];
  }

  /**
   * Execute a call with automatic retry + rotation on 429
   */
  async call(methodName, fn, retries = 3) {
    let lastError;
    for (let attempt = 0; attempt < retries; attempt++) {
      const connInfo = this._pickAvailable();
      const conn = connInfo.connection;
      try {
        const result = await fn(conn);
        this._markHealthy(connInfo.url);
        return result;
      } catch (e) {
        const msg = (e.message || String(e)).toLowerCase();

        // Rate limited — rotate
        if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
          this._markRateLimited(connInfo.url);
          lastError = e;
          // Small jitter before retrying on next endpoint
          await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
          continue;
        }

        // Connection error — rotate immediately (but NOT "account not found")
        if ((msg.includes('fetch failed') || msg.includes('socket') || msg.includes('timeout') ||
             msg.includes('etimedout') || msg.includes('econnreset') || msg.includes('enotfound')) &&
            !msg.includes('account')) {
          console.warn(`[RPC] 🔌 ${connInfo.label} connection error: ${msg.slice(0, 60)}`);
          this._markRateLimited(connInfo.url);
          lastError = e;
          await new Promise(r => setTimeout(r, 800));
          continue;
        }

        // "Account not found" — normal, throw immediately
        if (msg.includes('failed to get info about account') || msg.includes('account not found') || msg.includes('accountnotfound')) {
          throw e;
        }

        // Other — throw
        throw e;
      }
    }
    throw new Error(`RPC call '${methodName}' failed after ${retries} attempts: ${lastError ? lastError.message : 'unknown'}`);
  }

  async getBalance(publicKey) {
    return this.call('getBalance', (conn) => conn.getBalance(publicKey));
  }

  async getTokenAccountBalance(tokenAccount) {
    return this.call('getTokenAccountBalance', (conn) => conn.getTokenAccountBalance(tokenAccount));
  }

  async getAccountInfo(pubkey) {
    return this.call('getAccountInfo', (conn) => conn.getAccountInfo(pubkey));
  }

  async getTransaction(sig, opts) {
    return this.call('getTransaction', (conn) => conn.getTransaction(sig, opts));
  }

  async getSignaturesForAddress(address, opts) {
    return this.call('getSignaturesForAddress', (conn) => conn.getSignaturesForAddress(address, opts));
  }

  async getLatestBlockhash(commitment) {
    return this.call('getLatestBlockhash', (conn) => conn.getLatestBlockhash(commitment));
  }

  async sendTransaction(tx, opts) {
    return this.call('sendTransaction', (conn) => conn.sendTransaction(tx, opts));
  }

  async confirmTransaction(confirmation, commitment) {
    return this.call('confirmTransaction', (conn) => conn.confirmTransaction(confirmation, commitment));
  }

  /**
   * Subscribe to program logs (always uses the primary/best available WS endpoint)
   */
  onLogs(programId, callback, commitment) {
    const primaryConn = this._pickAvailable().connection;
    return primaryConn.onLogs(programId, callback, commitment);
  }

  removeOnLogs(subscriptionId) {
    const primaryConn = this.connections[this.currentIndex].connection;
    primaryConn.removeOnLogs(subscriptionId);
  }
}

module.exports = RpcManager;
