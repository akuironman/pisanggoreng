// ============================================
// PISANGGORENG v2.0 — GMGN SNIPER BOT
// Anti-Scam + Telegram + Partial TP + Moonbag
// ============================================
const solanaWeb3 = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require('@solana/spl-token');
const bs58 = require('bs58');
const config = require('./config');
const AntiScam = require('./anti-scam');
const TelegramNotifier = require('./telegram');
const JitoEngine = require('./jito');
// Node 22 built-in fetch

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
const walletAddress = walletKeypair.publicKey.toBase58();
console.log(`👛 Wallet: ${walletAddress}`);

// ─── Anti-Scam Engine ─────────────────────────
const antiScam = new AntiScam(connection);

// ─── Telegram Notifier ────────────────────────
const telegram = new TelegramNotifier({
  enabled: config.telegramEnabled,
  botToken: config.telegramBotToken,
  chatId: config.telegramChatId,
  useMarkdown: true,
});

// ─── Jito Bundle Engine ───────────────────────
const jito = new JitoEngine({
  enabled: config.enableJito,
  tipAmount: config.jitoTipAmount,
  blockEngineUrl: config.jitoBlockEngine,
  connection: connection,
  walletKeypair: walletKeypair,
  jupiterApi: config.jupiterApi,
});

// ─── State ────────────────────────────────────
const activePositions = new Map(); // mint -> Position
const closedTrades = [];
let lastTradeTime = 0;
let stats = { totalTrades: 0, tpHit: 0, slHit: 0, scamsBlocked: 0, pnl: 0 };

// ─── Position Class ──────────────────────────
class Position {
  constructor(mint, entrySol, tokenAmount, entryPriceUsd, buyTx) {
    this.mint = mint;
    this.entrySol = entrySol;
    this.tokenAmount = tokenAmount;
    this.entryPriceUsd = entryPriceUsd;
    this.buyTx = buyTx;
    this.time = Date.now();
    this.sold = false;
    this.partialSold = false;     // true if partial TP triggered
    this.moonbagActive = false;   // true if holding moonbag
    this.highestValue = entryPriceUsd * tokenAmount;
  }
}

// ─── Helpers ──────────────────────────────────
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

// ─── Get Token Balance ────────────────────────
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
    const WSOL = 'So11111111111111111111111111111111111111112';
    // Quote 1M lamports worth — using 0.001 SOL equivalent (harder for very cheap tokens)
    const resp = await fetch(
      `${config.jupiterApi}/quote?inputMint=${mintAddress}&outputMint=${WSOL}&amount=10000&slippageBps=${config.slippage * 100}`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || !data.outAmount) return null;

    // Route info
    const outSol = parseFloat(data.outAmount) / solanaWeb3.LAMPORTS_PER_SOL;
    const solPrice = await getSolPrice();
    // Price per token = SOL received / 10000 (the quoted amount in smallest units)
    // This is very rough — we use the actual balance value calc later
    return solPrice; // We return SOL price and use compare method instead
  } catch (e) {
    return null;
  }
}

// ─── Get Position Value in USD ────────────────
async function getPositionValueUsd(mintAddress, tokenAmount) {
  try {
    if (tokenAmount <= 0) return 0;
    const WSOL = 'So11111111111111111111111111111111111111112';
    // Use slightly more for accuracy
    const inputAmount = Math.max(1, Math.floor(tokenAmount * 1000000));
    const resp = await fetch(
      `${config.jupiterApi}/quote?inputMint=${mintAddress}&outputMint=${WSOL}&amount=${inputAmount}&slippageBps=${config.slippage * 100}`
    );
    if (!resp.ok) return 0;
    const data = await resp.json();
    if (!data || !data.outAmount) return 0;

    const outSol = parseFloat(data.outAmount) / solanaWeb3.LAMPORTS_PER_SOL;
    const factor = tokenAmount / (inputAmount / 1000000);
    const totalSol = outSol * factor;
    const solPrice = await getSolPrice();
    return totalSol * solPrice;
  } catch (e) {
    return 0;
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
    // For SELLING tokens: amount is already in human units, need smallest units
    // For BUYING with SOL: amount is in SOL, convert to lamports
    const isSolInput = inputMint === 'So11111111111111111111111111111111111111112';
    let amountLamports;
    if (isSolInput) {
      amountLamports = Math.floor(amount * solanaWeb3.LAMPORTS_PER_SOL);
    } else {
      // Token output — we already have it in token units, but need to figure out decimals
      // Use 1M as base and let Jupiter route
      amountLamports = Math.floor(amount * 1000000);
    }

    const slippageBps = Math.floor(config.slippage * 100);

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
        userPublicKey: walletAddress,
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
  // ─── JITO BUNDLE PATH ─────────────────────
  if (config.enableJito) {
    log.debug(`${label}: Trying Jito bundle...`);
    const bundleResult = await jito.sendSwapBundle(tx, label);
    if (bundleResult && bundleResult.confirmed) {
      const sig = bundleResult.txSignatures?.[0] || bundleResult;
      log.success(`✅ Jito: ${label} landed via bundle`);
      return typeof sig === 'string' ? sig : bundleResult;
    }
    log.warn(`${label}: Jito bundle failed, falling back to regular send...`);
  }

  // ─── REGULAR SEND PATH ────────────────────
  try {
    const sig = await connection.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'processed',
      maxRetries: 3,
    });
    log.debug(`${label} sent: ${sig}`);

    // Wait for confirmation
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('processed');
    const confirm = await connection.confirmTransaction({
      signature: sig,
      blockhash,
      lastValidBlockHeight,
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

    // ─── ANTI-SCAM CHECK ─────────────────────
    if (config.enableAntiScam) {
      log.info(`🛡️ Scanning ${mintAddress.slice(0,12)}... for scams...`);
      const scanResult = await antiScam.scan(mintAddress, config);
      if (!scanResult.pass) {
        log.warn(`🚫 BLOCKED: ${scanResult.reason}`);
        stats.scamsBlocked++;
        await telegram.onScamBlock(mintAddress, scanResult.reason);
        return false;
      }
      log.success(`✅ Anti-scam passed: ${scanResult.reason}`);
    }

    // Check SOL balance
    const solBalance = await getSolBalance();
    const needed = config.buyAmountSol * 1.05;
    if (solBalance < needed) {
      log.error(`Insufficient SOL: ${solBalance.toFixed(4)} (need ${needed.toFixed(4)})`);
      return false;
    }

    const WSOL = 'So11111111111111111111111111111111111111112';
    log.info(`🎯 BUY ${config.buyAmountSol} SOL → ${mintAddress.slice(0,12)}...`);

    const result = await buildSwapTx(WSOL, mintAddress, config.buyAmountSol);
    if (!result) {
      log.warn('BUY: Could not build swap tx');
      return false;
    }

    const sig = await executeTx(result.tx, 'BUY');
    if (!sig) return false;

    // Wait for settlement
    await sleep(3000);

    // Check balance
    const tokenBal = await getTokenBalance(mintAddress);
    if (tokenBal.amount <= 0) {
      log.warn('BUY: Token balance is 0 after tx');
      return false;
    }

    // Calculate entry price
    const solPrice = await getSolPrice();
    const entryPriceUsd = (config.buyAmountSol * solPrice) / tokenBal.amount;

    const position = new Position(
      mintAddress,
      config.buyAmountSol,
      tokenBal.amount,
      entryPriceUsd,
      sig
    );

    activePositions.set(mintAddress, position);
    lastTradeTime = Date.now();
    stats.totalTrades++;

    log.success(`BOUGHT ${mintAddress.slice(0,12)}... | Tokens: ${tokenBal.amount.toFixed(2)} | Entry: $${entryPriceUsd.toFixed(8)}`);
    log.trade(`Buy TX: https://solscan.io/tx/${sig}`);

    await telegram.onBuy(
      mintAddress,
      tokenBal.amount,
      config.buyAmountSol,
      entryPriceUsd,
      sig,
      config.enableAntiScam ? 'Scam check passed' : null
    );

    return true;
  } catch (e) {
    log.error('buyToken error:', e.message);
    return false;
  }
}

// ─── SELL ─────────────────────────────────────
async function sellToken(mintAddress, position, amountOverride = null, label = 'SELL') {
  try {
    let tokenBal;
    if (amountOverride) {
      tokenBal = { amount: amountOverride, decimals: 0, ata: null };
    } else {
      tokenBal = await getTokenBalance(mintAddress);
    }

    const actualAmount = amountOverride || tokenBal.amount;
    if (actualAmount <= 0) {
      log.warn(`${label}: No tokens to sell for ${mintAddress.slice(0,12)}...`);
      if (!amountOverride) position.sold = true;
      return false;
    }

    const WSOL = 'So11111111111111111111111111111111111111112';
    log.info(`💰 ${label} ${actualAmount.toFixed(4)} tokens → SOL`);

    // Build with smaller unit estimation
    const result = await buildSwapTx(mintAddress, WSOL, actualAmount);
    if (!result) {
      // Try with a smaller amount
      const altResult = await buildSwapTx(mintAddress, WSOL, actualAmount * 0.9);
      if (!altResult) return false;
      const sig = await executeTx(altResult.tx, label);
      if (!sig) return false;
      return sig;
    }

    const sig = await executeTx(result.tx, label);
    if (!sig) return false;

    return sig;
  } catch (e) {
    log.error(`${label} error:`, e.message);
    return false;
  }
}

// ─── Monitor Position — TP/SL/Moonbag Logic ───
async function monitorPosition(mintAddress, position) {
  try {
    const tokenBal = await getTokenBalance(mintAddress);
    if (tokenBal.amount <= 0 || position.sold) {
      if (!position.sold && tokenBal.amount <= 0) {
        log.warn(`Position ${mintAddress.slice(0,12)}... has 0 tokens, marking sold`);
        position.sold = true;
      }
      return;
    }

    // Get current position value
    const currentValueUsd = await getPositionValueUsd(mintAddress, tokenBal.amount);
    if (currentValueUsd <= 0) return;

    const entryValueUsd = position.entrySol * _cachedSolPrice;
    const profit = currentValueUsd - entryValueUsd;
    const profitPct = ((currentValueUsd / entryValueUsd) - 1) * 100;

    // Track highest value for trailing stop
    if (currentValueUsd > position.highestValue) {
      position.highestValue = currentValueUsd;
    }

    log.debug(`${mintAddress.slice(0,12)}... | Value: $${currentValueUsd.toFixed(2)} | PnL: $${profit.toFixed(2)} (${profitPct.toFixed(1)}%) | Tokens: ${tokenBal.amount.toFixed(2)}`);

    // ─── CHECK STOP LOSS ─────────────────────
    if (config.stopLossUsd > 0 && profit <= -config.stopLossUsd) {
      log.trade(`🔴 SL HIT! Loss $${Math.abs(profit).toFixed(2)} >= $${config.stopLossUsd} — Selling ALL`);
      stats.slHit++;
      const sig = await sellToken(mintAddress, position, null, 'SELL(SL)');
      if (sig) {
        position.sold = true;
        stats.pnl += profit;
        await telegram.onSell(mintAddress, profit, profitPct, currentValueUsd, sig);
      }
      return;
    }

    // ─── PARTIAL TP LOGIC ────────────────────
    if (config.enablePartialTp && !position.partialSold && profit >= config.tpUsd) {
      log.trade(`🚀 TP $${config.tpUsd} HIT! Profit $${profit.toFixed(2)} — Selling ${config.partialSellPct}%`);

      const sellAmount = tokenBal.amount * (config.partialSellPct / 100);
      const sig = await sellToken(mintAddress, position, sellAmount, 'SELL(TP)');
      if (sig) {
        position.partialSold = true;
        stats.tpHit++;
        stats.pnl += config.tpUsd; // rough

        await telegram.onTpHit(mintAddress, profit, profitPct, currentValueUsd);

        // ─── MOONBAG ─────────────────────────
        if (config.moonbagHoldPct > 0) {
          position.moonbagActive = true;
          const moonbagTokens = tokenBal.amount * (config.moonbagHoldPct / 100);
          // We already sold partial, recalc — the remaining balance is the moonbag
          log.trade(`🌙 Moonbag active! Holding ${config.moonbagHoldPct}% for $${config.moonbagTpUsd} TP`);
        }

        log.success(`✅ Partial TP executed. Remaining position: moonbag active`);
      }
      return;
    }

    // ─── MOONBAG SELL ───────────────────────
    if (position.moonbagActive && !position.sold) {
      if (profit >= config.moonbagTpUsd) {
        log.trade(`🌙 MOONBAG TP HIT! Profit $${profit.toFixed(2)} >= $${config.moonbagTpUsd} — Selling remainder`);
        const sig = await sellToken(mintAddress, position, null, 'SELL(MOONBAG)');
        if (sig) {
          position.sold = true;
          stats.pnl += profit;
          await telegram.onSell(mintAddress, profit, profitPct, currentValueUsd, sig);
        }
        return;
      }

      // Also sell moonbag if it drops below entry to prevent loss
      if (profit <= -config.tpUsd && config.stopLossUsd > 0) {
        log.trade(`🌙 Moonbag stop triggered — selling remainder at break-even`);
        const sig = await sellToken(mintAddress, position, null, 'SELL(MOONBAG-STOP)');
        if (sig) {
          position.sold = true;
          await telegram.onSell(mintAddress, profit, profitPct, currentValueUsd, sig);
        }
      }
    }

  } catch (e) {
    log.error('monitorPosition error:', e.message);
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
  for (const mint of closed) {
    activePositions.delete(mint);
    log.success(`🧹 Cleaned up ${mint.slice(0,12)}... from active positions`);
  }
}

// ─── Detect New Tokens ─────────────────────────
async function startTokenDetector() {
  log.info('🚀 Starting PISANGGORENG SNIPER BOT v2.0...');
  log.info(`📡 RPC: ${config.rpcEndpoint}`);
  log.info(`💵 TP: $${config.tpUsd} per entry`);
  if (config.stopLossUsd > 0) log.info(`🔴 SL: $${config.stopLossUsd}`);
  if (config.enablePartialTp) {
    log.info(`📊 Partial TP: Sell ${config.partialSellPct}% at TP, hold ${config.moonbagHoldPct}% moonbag for $${config.moonbagTpUsd}`);
  }
  log.info(`🛡️ Anti-scam: ${config.enableAntiScam ? 'ON' : 'OFF'}`);
  log.info(`📱 Telegram: ${config.telegramEnabled ? 'ON' : 'OFF'}`);
  log.info(`⚡ Jito Bundle: ${config.enableJito ? 'ON' : 'OFF'}${config.enableJito ? ` (tip: ${config.jitoTipAmount} SOL)` : ''}`);
  log.info(`💸 Buy amount: ${config.buyAmountSol} SOL`);
  log.info(`⏱️  Cooldown: ${config.cooldownMs}ms`);
  log.info('─────────────────────────────────────────');

  await getSolPrice();
  log.info(`💵 SOL/USD: $${_cachedSolPrice}`);

  const initialBal = await getSolBalance();
  log.info(`💰 Initial Balance: ${initialBal.toFixed(4)} SOL ($${(initialBal * _cachedSolPrice).toFixed(2)})`);

  // Telegram onStart notification
  await telegram.onStart({
    walletAddress,
    balanceSol: initialBal.toFixed(4),
    balanceUsd: (initialBal * _cachedSolPrice).toFixed(2),
    tpUsd: config.tpUsd,
    stopLossUsd: config.stopLossUsd,
    buyAmountSol: config.buyAmountSol,
    slippage: config.slippage,
    antiScam: config.enableAntiScam,
    partialTp: config.enablePartialTp,
    partialSellPct: config.partialSellPct,
    rpcEndpoint: config.rpcEndpoint,
  });

  // Listen to Pump.fun logs
  const pumpProgramId = new solanaWeb3.PublicKey(config.pumpProgramId);

  try {
    const subscriptionId = connection.onLogs(
      pumpProgramId,
      async (logs, ctx) => {
        if (logs.err) return;
        const logStr = logs.logs.join(' ');

        if (logStr.includes('Program log: Create') ||
            logStr.includes('initialize2') ||
            logStr.includes('Program log: initialize')) {

          log.info(`🔥 New token detected at slot ${ctx.slot}!`);

          // Extract mint from logs
          const mintMatch = logStr.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
          if (!mintMatch) return;

          const potentialMint = mintMatch[1];
          if (!activePositions.has(potentialMint) && potentialMint !== 'So11111111111111111111111111111111111111112') {
            // Check it's a valid mint
            try {
              new solanaWeb3.PublicKey(potentialMint);
              await sleep(800);
              const exists = await connection.getAccountInfo(new solanaWeb3.PublicKey(potentialMint));
              if (exists) {
                log.info(`🎯 Token mint confirmed: ${potentialMint}`);
                await buyToken(potentialMint);
              }
            } catch (e) {}
          }
        }
      },
      'processed'
    );

    log.success(`✅ Listening on Pump.fun logs (ID: ${subscriptionId})`);
  } catch (e) {
    log.error('WebSocket subscription failed:', e.message);
    log.info('⚠️  Falling back to polling...');
  }

  startPollingDetector();
}

// ─── Polling Detector ──────────────────────────
let polledTokens = new Set();
async function startPollingDetector() {
  log.info('🔄 Backup polling detector (every 5s)...');

  setInterval(async () => {
    try {
      const sigs = await connection.getSignaturesForAddress(
        new solanaWeb3.PublicKey(config.pumpProgramId),
        { limit: 20 }
      );

      for (const sigInfo of sigs) {
        if (polledTokens.has(sigInfo.signature)) continue;
        polledTokens.add(sigInfo.signature);

        const tx = await connection.getTransaction(sigInfo.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });

        if (tx && tx.meta && !tx.meta.err && tx.meta.postTokenBalances) {
          for (const tb of tx.meta.postTokenBalances) {
            if (tb.mint &&
                !activePositions.has(tb.mint) &&
                tb.mint !== 'So11111111111111111111111111111111111111112') {
              log.info(`🔍 [POLL] Found: ${tb.mint}`);
              await buyToken(tb.mint);
            }
          }
        }
      }
    } catch (e) {
      log.error('Polling error:', e.message);
    }
  }, 5000);
}

// ─── Position Monitor Loop ────────────────────
async function startPositionMonitor() {
  log.info('📊 Position monitor (every 10s)...');

  setInterval(async () => {
    if (activePositions.size === 0) {
      const bal = await getSolBalance();
      const solPrice = await getSolPrice();
      log.debug(`💤 Idle — ${bal.toFixed(4)} SOL ($${(bal * solPrice).toFixed(2)}) | ${activePositions.size} active`);
      return;
    }

    log.info(`📊 Monitoring ${activePositions.size} active position(s)...`);
    await monitorAllPositions();
  }, 10000);
}

// ─── Daily Summary ─────────────────────────────
function startDailySummary() {
  // Send a summary every 24h
  setInterval(async () => {
    const bal = await getSolBalance();
    const solPrice = await getSolPrice();
    await telegram.onDailySummary({
      totalTrades: stats.totalTrades,
      tpHit: stats.tpHit,
      slHit: stats.slHit,
      scamsBlocked: stats.scamsBlocked,
      pnl: stats.pnl,
      balanceSol: bal,
      balanceUsd: bal * solPrice,
    });
  }, 24 * 60 * 60 * 1000);
}

// ─── Main ─────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║    🍳 PISANGGORENG SNIPER v2.0            ║');
  console.log('║    Anti-Scam • Telegram • Partial TP      ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');

  startTokenDetector();
  startPositionMonitor();
  startDailySummary();

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

  // Show final stats
  const bal = await getSolBalance();
  const solPrice = await getSolPrice();
  console.log(`💰 Final Balance: ${bal.toFixed(4)} SOL ($${(bal * solPrice).toFixed(2)})`);
  console.log(`📊 Stats: ${stats.totalTrades} trades | ${stats.tpHit} TP | ${stats.slHit} SL | ${stats.scamsBlocked} scams blocked`);

  // Telegram summary
  await telegram.onTradeSummary([...activePositions.values()]);
  console.log('👋 Goodbye!');
  process.exit(0);
});

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
