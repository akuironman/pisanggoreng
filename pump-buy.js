// ============================================
// PISANGGORENG — DIRECT PUMP.FUN BUY ENGINE
// ============================================
// Buys tokens directly from Pump.fun bonding curve
// Skipping Jupiter — more accurate, lower price impact
// ============================================
const solanaWeb3 = require('@solana/web3.js');

const PUMP_PROGRAM = new solanaWeb3.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const SYSTEM_PROGRAM = solanaWeb3.SystemProgram.programId;
const TOKEN_PROGRAM = new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const RENT_PROGRAM = new solanaWeb3.PublicKey('SysvarRent111111111111111111111111111111111');
const ASSOC_TOKEN_PROGRAM = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xr25ix9fJf9WjJvdEG');
const PUMP_AUTHORITY = new solanaWeb3.PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE_ACCOUNT = new solanaWeb3.PublicKey('62TcAT7vXNJd16VNuLxgYgShQbLkKtsdbLCsQzvoE7Fq');
const PUMP_EVENT_AUTHORITY = new solanaWeb3.PublicKey('3URBjy26nfTgkUJBuU6DCmJsWHEPibLaSfmE7RsogwTT');

class PumpBuyEngine {
  constructor(config) {
    this.rpcManager = config.rpcManager;
    this.walletKeypair = config.walletKeypair;
    this.connection = config.rpcManager.getConnection();
    this.log = config.logger || console;
  }

  /**
   * Derive the bonding curve PDA for a given mint
   */
  getBondingCurveAddress(mintPubkey) {
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
      PUMP_PROGRAM
    );
    return pda;
  }

  /**
   * Derive the associated bonding curve token account
   */
  getAssociatedBondingCurveAddress(mintPubkey, curveAddress) {
    const [pda] = solanaWeb3.PublicKey.findProgramAddressSync(
      [curveAddress.toBuffer(), TOKEN_PROGRAM.toBuffer(), mintPubkey.toBuffer()],
      ASSOC_TOKEN_PROGRAM
    );
    return pda;
  }

  /**
   * Buy tokens directly from Pump.fun bonding curve
   * @param {string} mintAddress - Token mint to buy
   * @param {number} solAmount - Amount of SOL to spend
   * @returns {{ tx, sig } | null}
   */
  async buy(mintAddress, solAmount) {
    try {
      const mint = new solanaWeb3.PublicKey(mintAddress);
      const curveAddress = this.getBondingCurveAddress(mint);
      const user = this.walletKeypair.publicKey;

      // Get user's ATA for this token (might not exist yet — that's ok, pump creates it)
      const userAta = await this._findOrCreateAta(mint);

      // Get the curve's token account
      const curveTokenAddress = this.getAssociatedBondingCurveAddress(mint, curveAddress);

      // Calculate exact lamports
      const lamports = Math.floor(solAmount * solanaWeb3.LAMPORTS_PER_SOL);

      // Get current blockhash
      const { blockhash, lastValidBlockHeight } = await this.rpcManager.getLatestBlockhash('confirmed');

      // Calculate the minimum tokens out (based on bonding curve formula)
      // Pump.fun uses a constant product curve: (virtualTokenReserves * virtualSolReserves)
      // We estimate based on current curve state
      let minTokens = 0n;
      try {
        const curveInfo = await this.rpcManager.getAccountInfo(curveAddress);
        if (curveInfo && curveInfo.data.length >= 113) {
          const data = curveInfo.data;
          const virtualTokenReserves = data.readBigUInt64LE(64);
          const virtualSolReserves = data.readBigUInt64LE(72);
          const realTokenReserves = data.readBigUInt64LE(80);

          // k = virtualTokenReserves * virtualSolReserves (constant product)
          // newSolReserves = virtualSolReserves + lamports
          // newTokenReserves = k / newSolReserves
          // tokensOut = virtualTokenReserves - newTokenReserves
          const k = virtualTokenReserves * virtualSolReserves;
          const newSolReserves = virtualSolReserves + BigInt(lamports);
          const newTokenReserves = k / newSolReserves;
          const tokensOut = (virtualTokenReserves - newTokenReserves);

          // Apply 95% for safety (slippage protection)
          minTokens = tokensOut - (tokensOut * 5n / 100n);

          this.log.debug(`📊 Curve calc: ${tokensOut} tokens out (min ${minTokens})`);
        }
      } catch (e) {
        // If curve read fails, use 0 as min (no slippage protection but better than failing)
        this.log.warn(`⚠️ Could not calculate min tokens, using 0`);
      }

      // Build the direct Pump.fun buy instruction
      // Instruction: "buy" (discriminator 6606037033857761673)
      const buyDiscriminator = Buffer.alloc(8);
      buyDiscriminator.writeBigUInt64LE(6606037033857761673n);

      // Amount to spend (exact lamports)
      const amountBuffer = Buffer.alloc(8);
      amountBuffer.writeBigUInt64LE(BigInt(lamports));

      // Minimum tokens out (slippage protection)
      const minTokensBuffer = Buffer.alloc(8);
      minTokensBuffer.writeBigUInt64LE(minTokens > 0n ? minTokens : 0n);

      const data = Buffer.concat([buyDiscriminator, amountBuffer, minTokensBuffer]);

      // List of accounts for the Pump.fun buy instruction
      const keys = [
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },      // 0. pump program
        { pubkey: mint, isSigner: false, isWritable: false },               // 1. mint
        { pubkey: curveTokenAddress, isSigner: false, isWritable: true },   // 2. curve token account
        { pubkey: curveAddress, isSigner: false, isWritable: true },        // 3. bonding curve
        { pubkey: user, isSigner: true, isWritable: true },                 // 4. user wallet
        { pubkey: userAta, isSigner: false, isWritable: true },             // 5. user token account (ATA)
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },     // 6. system program
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },      // 7. token program
        { pubkey: RENT_PROGRAM, isSigner: false, isWritable: false },       // 8. rent sysvar
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 9. event authority
        { pubkey: PUMP_FEE_ACCOUNT, isSigner: false, isWritable: true },    // 10. fee account
        { pubkey: PUMP_AUTHORITY, isSigner: false, isWritable: false },     // 11. global authority
      ];

      const instruction = new solanaWeb3.TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys,
        data,
      });

      // Create legacy transaction (Pump.fun uses legacy, not V0)
      const tx = new solanaWeb3.Transaction();
      tx.feePayer = user;
      tx.recentBlockhash = blockhash;
      tx.add(instruction);
      tx.sign(this.walletKeypair);

      return { tx, lastValidBlockHeight };
    } catch (e) {
      this.log.error('PumpBuy: error:', e.message?.slice(0, 200));
      return null;
    }
  }

  /**
   * Get or create user's Associated Token Account for a mint
   * If it doesn't exist, we skip it — Pump.fun will create it
   */
  async _findOrCreateAta(mint) {
    try {
      const ata = await solanaWeb3.PublicKey.findProgramAddress(
        [this.walletKeypair.publicKey.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
        ASSOC_TOKEN_PROGRAM
      );
      return ata[0];
    } catch (e) {
      // Fallback
      return this.walletKeypair.publicKey;
    }
  }

  /**
   * Execute the buy transaction
   */
  async executeBuy(mintAddress, solAmount) {
    try {
      const result = await this.buy(mintAddress, solAmount);
      if (!result || !result.tx) {
        this.log.warn('PumpBuy: Failed to build transaction');
        return null;
      }

      const sig = await this.rpcManager.sendTransaction(result.tx, {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      this.log.debug(`PumpBuy: tx sent ${sig}`);

      // Confirm
      const { blockhash, lastValidBlockHeight } = await this.rpcManager.getLatestBlockhash('confirmed');
      const confirmResult = await this.rpcManager.confirmTransaction({
        signature: sig,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      if (confirmResult.value?.err) {
        this.log.error(`PumpBuy: tx failed:`, confirmResult.value.err);
        return null;
      }

      this.log.success(`✅ PumpBuy successful: ${sig}`);
      return sig;
    } catch (e) {
      this.log.error('PumpBuy execute error:', e.message?.slice(0, 200));
      return null;
    }
  }
}

module.exports = PumpBuyEngine;
