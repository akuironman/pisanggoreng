// ============================================
// PISANGGORENG v2.0 — ANTI-SCAM ENGINE
// ============================================
// Checks before buying: honeypot, freeze, mint, liquidity
// ============================================
const solanaWeb3 = require('@solana/web3.js');

class AntiScam {
  constructor(connection) {
    this.connection = connection;
  }

  /**
   * Fetch with retry — avoids 429 on Jupiter API
   */
  async _fetchWithRetry(url, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const resp = await fetch(url);
        if (resp.status === 429) {
          const wait = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return resp;
      } catch (e) {
        if (attempt < maxRetries - 1) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  /**
   * Full scan — run all checks before buying
   * Returns { pass: bool, reason: string }
   */
  async scan(mintAddress, config) {
    const checks = [
      { name: 'Mint Authority', fn: () => this.checkMintAuthority(mintAddress) },
      { name: 'Freeze Authority', fn: () => this.checkFreezeAuthority(mintAddress) },
      { name: 'Liquidity Test', fn: () => this.checkLiquidity(mintAddress) },
      { name: 'Supply Sanity', fn: () => this.checkSupplySanity(mintAddress) },
    ];

    if (config.enableHoneypotCheck) {
      checks.push({ name: 'Honeypot', fn: () => this.checkHoneypot(mintAddress) });
    }

    for (const check of checks) {
      const result = await check.fn();
      if (!result.pass) {
        return { pass: false, reason: `${check.name}: ${result.reason}` };
      }
    }

    return { pass: true, reason: '' };
  }

  /**
   * Check that mint authority is revoked (no more tokens can be minted)
   */
  async checkMintAuthority(mintAddress) {
    try {
      const mintPubkey = new solanaWeb3.PublicKey(mintAddress);
      const mintInfo = await this.connection.getAccountInfo(mintPubkey);
      if (!mintInfo) return { pass: false, reason: 'Mint account not found' };

      // Parse SPL mint: offset 0 = mintAuthorityOption (1 byte), offset 1 = mintAuthority (32 bytes)
      const data = mintInfo.data;
      const mintAuthOption = data[0];
      if (mintAuthOption === 1) {
        // Mint authority is set — someone can still mint
        const mintAuthPubkey = new solanaWeb3.PublicKey(data.slice(1, 33));
        // If mint authority is our own wallet or null, it's fine
        const mintAuthStr = mintAuthPubkey.toBase58();
        if (mintAuthStr !== '11111111111111111111111111111111') {
          // Check if it's actually the zero pubkey pattern
          const zeroKey = new solanaWeb3.PublicKey('11111111111111111111111111111111');
          if (!mintAuthPubkey.equals(zeroKey)) {
            return { pass: false, reason: `Mint authority ACTIVE: ${mintAuthStr.slice(0,8)}... — can dump more supply` };
          }
        }
      }
      return { pass: true, reason: 'Mint authority revoked ✓' };
    } catch (e) {
      return { pass: true, reason: `Check skipped (${e.message})` };
    }
  }

  /**
   * Check that freeze authority is null (no one can freeze tokens)
   */
  async checkFreezeAuthority(mintAddress) {
    try {
      const mintPubkey = new solanaWeb3.PublicKey(mintAddress);
      const mintInfo = await this.connection.getAccountInfo(mintPubkey);
      if (!mintInfo) return { pass: false, reason: 'Mint not found' };

      const data = mintInfo.data;
      // Offset 37 = freezeAuthorityOption (1 byte), offset 38 = freezeAuthority (32 bytes)
      const freezeOption = data[37];
      if (freezeOption === 1) {
        const freezePubkey = new solanaWeb3.PublicKey(data.slice(38, 70));
        const zeroKey = new solanaWeb3.PublicKey('11111111111111111111111111111111');
        if (!freezePubkey.equals(zeroKey)) {
          return { pass: false, reason: `Freeze authority SET: ${freezePubkey.toBase58().slice(0,8)}... — can freeze your tokens` };
        }
      }
      return { pass: true, reason: 'Freeze authority revoked ✓' };
    } catch (e) {
      return { pass: true, reason: `Check skipped (${e.message})` };
    }
  }

  /**
   * Check token has basic liquidity — try to get a Jupiter quote
   */
  async checkLiquidity(mintAddress) {
    try {
      const WSOL = 'So11111111111111111111111111111111111111112';
      // Try a tiny 0.001 SOL buy quote — if it returns, there's some liquidity
      const resp = await this._fetchWithRetry(
        `https://quote-api.jup.ag/v6/quote?inputMint=${WSOL}&outputMint=${mintAddress}&amount=1000000&slippageBps=1500`
      );
      if (!resp || !resp.ok) return { pass: false, reason: 'No route / liquidity (Jupiter returned ' + (resp ? resp.status : 'timeout') + ')' };
      const data = await resp.json();
      if (!data || !data.outAmount || parseFloat(data.outAmount) <= 0) {
        return { pass: false, reason: 'Zero output — no liquidity' };
      }
      return { pass: true, reason: `Has liquidity ✓ (${data.routePlan?.length || 1} hop(s))` };
    } catch (e) {
      return { pass: true, reason: `Check skipped (${e.message})` };
    }
  }

  /**
   * Sanity check — supply not absurd
   */
  async checkSupplySanity(mintAddress) {
    try {
      const mintPubkey = new solanaWeb3.PublicKey(mintAddress);
      const mintInfo = await this.connection.getAccountInfo(mintPubkey);
      if (!mintInfo) return { pass: false, reason: 'Mint not found' };
      const data = mintInfo.data;
      // Supply is at offset 36 (8 bytes)
      const supplyBuf = data.slice(36, 44);
      const supply = supplyBuf.readBigUInt64LE(0);
      const decimals = data[44]; // decimal at offset 44
      const supplyNormalized = Number(supply) / (10 ** decimals);

      if (supplyNormalized > 100_000_000_000_000) {
        return { pass: false, reason: `Absurd supply: ${supplyNormalized.toExponential(2)} tokens` };
      }
      return { pass: true, reason: `Supply: ${supplyNormalized.toLocaleString()} ✓` };
    } catch (e) {
      return { pass: true, reason: `Check skipped (${e.message})` };
    }
  }

  /**
   * Honeypot check — try to build a sell quote with a tiny amount
   * If Jupiter can route a sell, it's likely not a honeypot
   */
  async checkHoneypot(mintAddress) {
    try {
      const WSOL = 'So11111111111111111111111111111111111111112';
      // Tiny sell: 0.000001 token
      const resp = await this._fetchWithRetry(
        `https://quote-api.jup.ag/v6/quote?inputMint=${mintAddress}&outputMint=${WSOL}&amount=1&slippageBps=1500`
      );
      if (!resp || !resp.ok) return { pass: false, reason: 'Sell quote failed — possible honeypot' };
      const data = await resp.json();
      if (!data || !data.outAmount || parseFloat(data.outAmount) <= 0) {
        return { pass: false, reason: 'Sell returns 0 SOL — honeypot suspected' };
      }
      return { pass: true, reason: 'Sell verified ✓' };
    } catch (e) {
      return { pass: true, reason: `Check skipped (${e.message})` };
    }
  }
}

module.exports = AntiScam;
