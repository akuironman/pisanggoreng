// ============================================
// PISANGGORENG v3.0 — BONDING CURVE TRACKER
// ============================================
// Tracks Pump.fun bonding curve progress and
// executes buy ONLY when target % is reached.
// ============================================
const solanaWeb3 = require('@solana/web3.js');

class CurveTracker {
  constructor(config) {
    this.connection = config.connection;
    this.rpcManager = config.rpcManager;
    this.targetProgress = config.targetProgress || 10;
    this.checkInterval = config.checkInterval || 3000;
    this.maxWaitMs = config.maxWaitMs || 120000;
    this.pumpProgramId = new solanaWeb3.PublicKey(
      config.pumpProgramId || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    );
  }

  _log(...args) {
    console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] 📊`, ...args);
  }

  /**
   * Derive the bonding curve PDA for a given mint
   */
  getBondingCurveAddress(mintPubkey) {
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
      this.pumpProgramId
    );
    return pda;
  }

  /**
   * Parse bonding curve account data
   * Pump.fun curve layout:
   *   mint (32) + curve (32) + virtualTokenReserves (8) 
   *   + virtualSolReserves (8) + realTokenReserves (8) 
   *   + realSolReserves (8) + tokenTotalSupply (8) + complete (1)
   */
  parseCurveData(data) {
    if (!data || data.length < 113) return null;

    return {
      mint: new solanaWeb3.PublicKey(data.slice(0, 32)),
      curve: new solanaWeb3.PublicKey(data.slice(32, 64)),
      virtualTokenReserves: data.readBigUInt64LE(64),
      virtualSolReserves: data.readBigUInt64LE(72),
      realTokenReserves: data.readBigUInt64LE(80),
      realSolReserves: data.readBigUInt64LE(88),
      tokenTotalSupply: data.readBigUInt64LE(96),
      complete: data[104] === 1,
    };
  }

  /**
   * Fetch current bonding curve progress
   * Returns { progressPct, curveData, error? }
   */
  async getProgress(mintAddress) {
    try {
      const mint = new solanaWeb3.PublicKey(mintAddress);
      const curveAddress = this.getBondingCurveAddress(mint);

      const accountInfo = await this.rpcManager.getAccountInfo(curveAddress);
      if (!accountInfo) {
        return { progressPct: 0, curveData: null, error: 'Curve account not found' };
      }

      const curve = this.parseCurveData(accountInfo.data);
      if (!curve) {
        return { progressPct: 0, curveData: null, error: 'Failed to parse curve' };
      }

      // Pump.fun bonding curve progress:
      // tokenTotalSupply = total tokens ever available on curve
      // realTokenReserves = tokens still remaining
      // sold = tokenTotalSupply - realTokenReserves
      // progress = sold / tokenTotalSupply * 100
      const totalSupply = Number(curve.tokenTotalSupply);
      const remaining = Number(curve.realTokenReserves);

      let progressPct = 0;
      if (totalSupply > 0) {
        progressPct = ((totalSupply - remaining) / totalSupply) * 100;
      }

      // Alternative: based on SOL in curve
      // virtualSolReserves starts at ~30 SOL
      // When it reaches ~85 SOL, curve is complete
      const initialVirtualSol = 30000000000n; // 30 SOL in lamports
      const targetVirtualSol = 85000000000n;  // 85 SOL target
      const solProgress = curve.virtualSolReserves > 0n
        ? Number((curve.virtualSolReserves - initialVirtualSol) * 100n / (targetVirtualSol - initialVirtualSol))
        : 0;

      // Use the higher of the two metrics
      const finalProgress = Math.max(progressPct, solProgress);

      return {
        progressPct: Math.min(100, Math.max(0, finalProgress)),
        curveAddress: curveAddress.toBase58(),
        curveData: curve,
        solProgress,
        tokenProgress: progressPct,
      };
    } catch (e) {
      return { progressPct: 0, curveData: null, error: e.message };
    }
  }

  /**
   * Wait until bonding curve reaches target progress
   * Calls the callback once target is reached
   * Returns false if max wait is exceeded
   */
  async waitForTargetProgress(mintAddress, onTargetReached, onPoll) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastProgress = 0;
      let monotonicProgress = 0;

      const interval = setInterval(async () => {
        // Max wait check
        if (Date.now() - startTime > this.maxWaitMs) {
          clearInterval(interval);
          this._log(`⏰ Max wait ${this.maxWaitMs/1000}s exceeded for ${mintAddress.slice(0,12)}... — buying anyway`);
          await onTargetReached(mintAddress, 100);
          resolve(false);
          return;
        }

        const result = await this.getProgress(mintAddress);

        if (result.error) {
          this._log(`Curve ${mintAddress.slice(0,12)}...: ${result.error}`);
          if (onPoll) onPoll(result);
          return;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const pct = result.progressPct.toFixed(1);

        // Track monotonic progress (real upward trend)
        if (result.progressPct > lastProgress) {
          monotonicProgress = result.progressPct;
        }
        lastProgress = result.progressPct;

        if (onPoll) onPoll(result);

        // Check if curve is complete (100%)
        if (result.curveData?.complete) {
          this._log(`✅ Curve COMPLETE for ${mintAddress.slice(0,12)}... — buying`);
          clearInterval(interval);
          await onTargetReached(mintAddress, 100);
          resolve(true);
          return;
        }

        // Check if we hit target
        if (monotonicProgress >= this.targetProgress) {
          this._log(`🎯 Target ${this.targetProgress}% REACHED! (${pct}%) in ${elapsed}s — buying ${mintAddress.slice(0,12)}...`);
          clearInterval(interval);
          await onTargetReached(mintAddress, monotonicProgress);
          resolve(true);
          return;
        }

        this._log(`${mintAddress.slice(0,12)}... curve: ${pct}% / ${this.targetProgress}% target (${elapsed}s)`);
      }, this.checkInterval);
    });
  }

  /**
   * Quick check if curve already past target — buy immediately
   */
  async shouldBuyNow(mintAddress) {
    const result = await this.getProgress(mintAddress);
    if (result.error) {
      // If we can't read curve, buy anyway (safer to miss than to skip)
      this._log(`⚠️ Curve check failed for ${mintAddress.slice(0,12)}... — buying anyway`);
      return { buy: true, progress: 0 };
    }
    if (result.progressPct >= this.targetProgress || result.curveData?.complete) {
      this._log(`✅ Curve ${result.progressPct.toFixed(1)}% >= ${this.targetProgress}% — buying now`);
      return { buy: true, progress: result.progressPct };
    }
    return { buy: false, progress: result.progressPct };
  }
}

module.exports = CurveTracker;
