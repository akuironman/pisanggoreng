// ============================================
// GMGN SNIPER BOT — CORE ENGINE
// Auto-detect tokens → Buy → TP $5 → Sell → Loop
// ============================================
const solanaWeb3 = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const bs58 = require('bs58');
const config = require('./config');
// Node 22 built-in fetch — no import needed

// ─── Logger ───────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const logLevel = LOG_LEVELS[config.logLevel] ?? 2;
const log = {
  error: (...a) => logLevel >= 0 && console.error(`[${ts()}] ❌`, ...a),
  warn:  (...a) => logLevel >= 1 && console.warn(`[${ts()}] ⚠️`, ...a),
  info:  (...a) => logLevel >= 2 && console.log(`[${ts()}] ℹ️`, ...a),
  debug: (...a) => logLevel >= 3 && console.log(`[${ts()}] 🔍`, ...a),
  success: (...a) => console.log(`[${ts()}] ✅`, ...a),
  trade: (...a) => console.log(`[${ts()}] 💰`, ...a),
};
function ts() {
  return new Date().toISOString().replace('T',' ').slice(0,19);
}

// ─── Solana Connection ────────────────────────
const connection = new solanaWeb3.Connection(config.rpcEndpoint, {
  wsEndpoint: config.rpcWs,
  commitment: 'processed',
});

// ─── Wallet ───────────────────────────────────
const walletKeypair = solanaWeb3.Keypair.fromSecretKey(
  bs58.decode(config.privateKey)
);
console.log(`👛 Wallet: ${walletKeypair.publicKey.toBase58()}`);
console.log(`💰 Balance: fetching...`);

// ─── State ────────────────────────────────────
const activePositions = new Map(); // mint -> { mint, entryPrice, entrySol, buyTx, tokenAccount, time }
let lastTradeTime = 0;

// ─── Helpers ──────────────────────────────────
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ─── Get SOL Balance ──────────────────────────
async function getSolBalance() {
  try {
    const bal = await connection.getBalance(walletKeypair.publicKey);
    return bal / solanaWeb3.LAMPORTS_PER_SOL;
  } catch (e) {
    log.error('Failed to fetch SOL balance:', e.message);
    return 0;
  }
}

// ─── Get Token Balance (UI amount) ────────────
async function getTokenBalance(mintAddress) {
  try {
    const mint = new solanaWeb3.PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mint, walletKeypair.publicKey);
    const balance = await connection.getTokenAccountBalance(ata);
    const amount = parseFloat(balance.value.uiAmountString || '0');
    const decimals = balance.value.decimals;
    return { amount, decimals, ata };
  } catch (e) {
    return { amount: 0, decimals: 0, ata: null };
  }
}

// ─── Get Token Price from Jupiter ─────────────
async function getTokenPrice(mintAddress) {
  try {
    const resp = await fetch(
      `${config.jupiterApi}/quote?inputMint=${mintAddress}&outputMint=So11111111111111111111111111111111111111112&amount=1000000&slippageBps=${config.slippage * 100}`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.outAmount) return null;
    const outSol = parseFloat(data.outAmount) / solanaWeb3.LAMPORTS_PER_SOL;
    const pricePerToken = outSol / (1000000 / 10 ** 6); // rough
    const solPrice = await getSolPrice();
    return pricePerToken * solPrice;
  } catch (e) {
    return null;
  }
}

// ─── SOL/USD Price ────────────────────────────
let _cachedSolPrice = 150;
let _lastSolPriceFetch = 0;
async function getSolPrice() {
  if (Date.now() - _lastSolPriceFetch < 30000) return _cachedSolPrice;
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (resp.ok) {
      const data = await resp.json();
      _cachedSolPrice = data.solana.usd;
      _lastSolPriceFetch = Date.now();
    }
  } catch (e) {}
  return _cachedSolPrice;
}

// ─── Build Jupiter Swap Tx ────────────────────
async function buildSwapTx(inputMint, outputMint, amount, isExactOut = false) {
  try {
    const slippageBps = Math.floor(config.slippage * 100);
    const amountLamports = Math.floor(amount * solanaWeb3.LAMPORTS_PER_SOL);

    // Quote
    const quoteParams = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amountLamports),
      slippageBps: String(slippageBps),
      feeBps: '0',
      onlyDirectRoutes: 'false',
    });
    if (isExactOut) quoteParams.set('swapMode', 'ExactOut');

    const quoteResp = await fetch(`${config.jupiterApi}/quote?${quoteParams}`);
    if (!quoteResp.ok) {
      const text = await quoteResp.text();
      log.warn(`Jupiter quote failed (${quoteResp.status}): ${text.slice(0,200)}`);
      return null;
    }
    const quote = await quoteResp.json();

    // Swap instructions
    const swapResp = await fetch(`${config.jupiterApi}/swap-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: walletKeypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          computeUnitLimit: 200000,
          priorityLevel: 'veryHigh',
        },
      }),
    });
    if (!swapResp.ok) return null;
    const swapData = await swapResp.json();

    // Reconstruct transaction
    const tx = solanaWeb3.VersionedTransaction.deserialize(
      Buffer.from(swapData.swapTransaction, 'base64')
    );
    tx.sign([walletKeypair]);

    return { tx, quote };
  } catch (e) {
    log.error('buildSwapTx error:', e.message);
    return null;
  }
}

// ─── Execute Transaction ──────────────────────
async function executeTx(tx, label = 'tx') {
  try {
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'processed',
      maxRetries: 3,
    });
    log.debug(`${label} sent: ${sig}`);

    // Wait for confirmation
    const confirm = await connection.confirmTransaction({
      signature: sig,
      blockhash: (await connection.getLatestBlockhash()).blockhash,
      lastValidBlockHeight: (await connection.getLatestBlockhash('processed')).lastValidBlockHeight,
    }, 'confirmed');

    if (confirm.value.err) {
      log.error(`${label} failed:`, confirm.value.err);
      return null;
    }
    return sig;
  } catch (e) {
    log.error(`${label} execution error:`, e.message);
    return null;
  }
}

// ─── BUY ──────────────────────────────────────
async function buyToken(mintAddress) {
  try {
    // Cooldown check
    if (Date.now() - lastTradeTime < config.cooldownMs) {
      const wait = config.cooldownMs - (Date.now() - lastTradeTime);
      log.debug(`Cooldown ${wait}ms...`);
      await sleep(wait);
    }

    // Check SOL balance
    const solBalance = await getSolBalance();
    const needed = config.buyAmountSol * 1.05; // 5% buffer for fees
    if (solBalance < needed) {
      log.error(`Insufficient SOL: ${solBalance.toFixed(4)} (need ${needed.toFixed(4)})`);
      return false;
    }

    const mint = new solanaWeb3.PublicKey(mintAddress);
    const WSOL = 'So11111111111111111111111111111111111111112';

    log.info(`🎯 BUY ${config.buyAmountSol} SOL → ${mintAddress.slice(0,12)}...`);

    const result = await buildSwapTx(WSOL, mintAddress, config.buyAmountSol);
    if (!result) {
      log.warn('BUY: Could not build swap tx');
      return false;
    }

    const sig = await executeTx(result.tx, 'BUY');
    if (!sig) return false;

    // Wait a bit for balances to settle
    await sleep(3000);

    // Check balance
    const tokenBal = await getTokenBalance(mintAddress);
    if (tokenBal.amount <= 0) {
      log.warn('BUY: Token balance is 0 after tx — may be a scam or failed');
      return false;
    }

    // Calculate entry price
    const solPrice = await getSolPrice();
    const entryPriceUsd = (config.buyAmountSol * solPrice) / tokenBal.amount;

    const position = {
      mint: mintAddress,
      entryPriceUsd,
      entrySol: config.buyAmountSol,
      tokenAmount: tokenBal.amount,
      buyTx: sig,
      time: Date.now(),
      sold: false,
    };

    activePositions.set(mintAddress, position);
    lastTradeTime = Date.now();

    log.success(`BOUGHT ${mintAddress.slice(0,12)}... | Tokens: ${tokenBal.amount.toFixed(2)} | Entry: $${entryPriceUsd.toFixed(8)}`);
    log.trade(`Buy TX: https://solscan.io/tx/${sig}`);

    return true;
  } catch (e) {
    log.error('buyToken error:', e.message);
    return false;
  }
}

// ─── SELL ─────────────────────────────────────
async function sellToken(mintAddress, position) {
  try {
    const tokenBal = await getTokenBalance(mintAddress);
    if (tokenBal.amount <= 0) {
      log.warn(`SELL: No tokens to sell for ${mintAddress.slice(0,12)}...`);
      position.sold = true;
      return false;
    }

    const actualAmount = tokenBal.amount;
    const WSOL = 'So11111111111111111111111111111111111111112';

    log.info(`💰 SELL ${actualAmount.toFixed(4)} tokens → SOL`);

    const result = await buildSwapTx(mintAddress, WSOL, actualAmount);
    if (!result) {
      log.warn('SELL: Could not build swap tx — trying exact out');
      // Try alternative: sell a fixed small amount
      const altResult = await buildSwapTx(mintAddress, WSOL, actualAmount * 0.99);
      if (!altResult) return false;
      const sig = await executeTx(altResult.tx, 'SELL');
      if (!sig) return false;
      position.sold = true;
      log.success(`SOLD ${mintAddress.slice(0,12)}... | TX: https://solscan.io/tx/${sig}`);
      return true;
    }

    const sig = await executeTx(result.tx, 'SELL');
    if (!sig) return false;

    position.sold = true;
    log.success(`SOLD ${mintAddress.slice(0,12)}... ✅`);
    log.trade(`Sell TX: https://solscan.io/tx/${sig}`);

    return true;
  } catch (e) {
    log.error('sellToken error:', e.message);
    return false;
  }
}

// ─── Monitor Position — TP $5 → Sell ─────────
async function monitorPosition(mintAddress, position) {
  try {
    const tokenBal = await getTokenBalance(mintAddress);
    if (tokenBal.amount <= 0 || position.sold) {
      if (!position.sold) {
        log.warn(`Position ${mintAddress.slice(0,12)}... has 0 tokens, marking sold`);
        position.sold = true;
      }
      return;
    }

    // Get current price estimate
    const solPrice = await getSolPrice();
    const tokenPrice = await getTokenPrice(mintAddress);

    if (tokenPrice === null) {
      log.debug(`No price for ${mintAddress.slice(0,12)}... yet`);
      return;
    }

    const currentValue = tokenPrice * tokenBal.amount;
    const profit = currentValue - (position.entryPriceUsd * tokenBal.amount);
    const profitPct = ((currentValue / (position.entryPriceUsd * tokenBal.amount)) - 1) * 100;

    log.debug(`${mintAddress.slice(0,12)}... | Value: $${currentValue.toFixed(2)} | PnL: $${profit.toFixed(2)} (${profitPct.toFixed(1)}%)`);

    // Check TP
    if (profit >= config.tpUsd) {
      log.trade(`🚀 TP HIT! Profit $${profit.toFixed(2)} >= $${config.tpUsd} — Selling NOW`);
      await sellToken(mintAddress, position);
      return true;
    }

    return false;
  } catch (e) {
    log.error('monitorPosition error:', e.message);
    return false;
  }
}

// ─── Monitor ALL Active Positions ─────────────
async function monitorAllPositions() {
  const closed = [];
  for (const [mint, pos] of activePositions) {
    if (pos.sold) {
      closed.push(mint);
      continue;
    }
    await monitorPosition(mint, pos);
  }
  // Cleanup sold positions
  for (const mint of closed) {
    activePositions.delete(mint);
    log.success(`🧹 Cleaned up ${mint.slice(0,12)}... from active positions`);
  }
}

// ─── Detect New Tokens (Pump.fun Log Listener) ─
async function startTokenDetector() {
  log.info('🚀 Starting GMGN Sniper Bot...');
  log.info(`📡 RPC: ${config.rpcEndpoint}`);
  log.info(`💵 TP: $${config.tpUsd} per entry`);
  log.info(`💸 Buy amount: ${config.buyAmountSol} SOL`);
  log.info(`⏱️  Cooldown: ${config.cooldownMs}ms`);
  log.info('─────────────────────────────────────────');
  log.info('👀 Listening for new Pump.fun tokens...');

  // Get SOL price once
  await getSolPrice();
  log.info(`💵 SOL/USD: $${_cachedSolPrice}`);

  // Log initial balance
  const initialBal = await getSolBalance();
  log.info(`💰 Initial Balance: ${initialBal.toFixed(4)} SOL ($${(initialBal * _cachedSolPrice).toFixed(2)})`);

  // APPROACH 1: Subscribe to program logs (Pump.fun)
  // We watch for create + initialize events
  const pumpProgramId = new solanaWeb3.PublicKey(config.pumpProgramId);
  let subscriptionId = null;

  try {
    subscriptionId = connection.onLogs(
      pumpProgramId,
      async (logs, ctx) => {
        if (logs.err) return;

        const logStr = logs.logs.join(' ');

        // Detect new token creation — Pump.fun "create" events
        // Typical signatures: "Program log: Create", "initialize2", "Program log: Instruction: Create"
        if (logStr.includes('Program log: Create') ||
            logStr.includes('initialize2') ||
            logStr.includes('Program log: initialize')) {

          log.info(`🔥 New token detected at slot ${ctx.slot}!`);

          // Extract token mint from logs (Pump.fun specific parsing)
          const mintMatch = logStr.match(/mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/) ||
                           logStr.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);

          if (!mintMatch) {
            log.debug('Could not extract mint from logs — trying by parsing keys...');
            // Try to get recent transactions to find the token
            await sleep(500);
            const recentSigs = await connection.getSignaturesForAddress(
              pumpProgramId,
              { limit: 10 }
            );
            if (recentSigs.length > 0) {
              log.info(`📄 Found ${recentSigs.length} recent txs — scanning for new mints...`);
              for (const sigInfo of recentSigs.slice(0, 3)) {
                try {
                  const tx = await connection.getTransaction(sigInfo.signature, {
                    commitment: 'confirmed',
                    maxSupportedTransactionVersion: 0,
                  });
                  if (tx && tx.meta && !tx.meta.err) {
                    // Check post-token balances for new token accounts
                    if (tx.meta.postTokenBalances) {
                      for (const tb of tx.meta.postTokenBalances) {
                        if (tb.owner === walletKeypair.publicKey.toBase58() && tb.mint) {
                          log.info(`🎯 Found new token mint: ${tb.mint}`);
                          // Check if already in positions
                          if (!activePositions.has(tb.mint)) {
                            await buyToken(tb.mint);
                          }
                          return;
                        }
                      }
                    }
                  }
                } catch (e) {}
              }
            }
            return;
          }

          const potentialMint = mintMatch[1];
          if (!activePositions.has(potentialMint)) {
            await sleep(500); // Give the token time to populate
            const exists = await connection.getAccountInfo(new solanaWeb3.PublicKey(potentialMint));
            if (exists) {
              log.info(`🎯 Token mint found: ${potentialMint}`);
              await buyToken(potentialMint);
            }
          }
        }
      },
      'processed'
    );

    log.success(`✅ Listening on Pump.fun via logs — subscription ID: ${subscriptionId}`);

  } catch (e) {
    log.error('Failed to subscribe to program logs:', e.message);
    log.info('⚠️  Falling back to polling mode...');
  }

  // APPROACH 2: Alternate detector via recent transactions polling
  // This catches tokens we might have missed via logs
  startPollingDetector();
}

// ─── Polling Detector (Fallback) ──────────────
let polledTokens = new Set();
async function startPollingDetector() {
  log.info('🔄 Starting backup polling detector (every 5s)...');

  setInterval(async () => {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new solanaWeb3.PublicKey(config.pumpProgramId),
        { limit: 20 }
      );

      for (const sigInfo of sigs) {
        if (polledTokens.has(sigInfo.signature)) continue;
        polledTokens.add(sigInfo.signature);

        try {
          const tx = await connection.getTransaction(sigInfo.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });

          if (tx && tx.meta && !tx.meta.err && tx.meta.postTokenBalances) {
            for (const tb of tx.meta.postTokenBalances) {
              if (tb.mint &&
                  !activePositions.has(tb.mint) &&
                  tb.mint !== 'So11111111111111111111111111111111111111112') {
                log.info(`🔍 [POLL] Found new token via polling: ${tb.mint}`);
                await buyToken(tb.mint);
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {
      log.error('Polling error:', e.message);
    }
  }, 5000);
}

// ─── Position Monitor Loop ────────────────────
async function startPositionMonitor() {
  log.info('📊 Starting position monitor (every 10s)...');

  setInterval(async () => {
    if (activePositions.size === 0) {
      // Show status every 30s even when idle
      const bal = await getSolBalance();
      const solPrice = await getSolPrice();
      log.debug(`💤 Idle — ${bal.toFixed(4)} SOL ($${(bal * solPrice).toFixed(2)}) | ${activePositions.size} active positions`);
      return;
    }

    log.info(`📊 Monitoring ${activePositions.size} active position(s)...`);
    await monitorAllPositions();
  }, 10000);
}

// ─── Main ─────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║      🚀 GMGN SNIPER BOT v1.0          ║');
  console.log('║   Auto Trade | TP $5 | Cycle Loop      ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log('');

  // Start all modules
  startTokenDetector();
  startPositionMonitor();

  // Keep alive signal
  console.log('');
  console.log('✅ BOT RUNNING — Press Ctrl+C to stop');
  console.log('');
}

// ─── Graceful Shutdown ────────────────────────
process.on('SIGINT', async () => {
  console.log('\n\n⚠️  Shutting down...');

  // Sell all open positions
  if (activePositions.size > 0) {
    console.log(`📤 Selling ${activePositions.size} open position(s)...`);
    for (const [mint, pos] of activePositions) {
      if (!pos.sold) {
        await sellToken(mint, pos);
        await sleep(1000);
      }
    }
  }

  // Show final balance
  const bal = await getSolBalance();
  const solPrice = await getSolPrice();
  console.log(`💰 Final Balance: ${bal.toFixed(4)} SOL ($${(bal * solPrice).toFixed(2)})`);
  console.log('👋 Goodbye!');
  process.exit(0);
});

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
