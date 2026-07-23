// ============================================
// PISANGGORENG v2.0 — CONFIG LOADER
// ============================================
require('dotenv').config();

const config = {
  // ─── Wallet ──────────────────────────────────
  privateKey: process.env.PRIVATE_KEY || '',
  publicKey: process.env.PUBLIC_KEY || '',

  // ─── RPC ─────────────────────────────────────
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  rpcWs: process.env.RPC_WS || 'wss://api.mainnet-beta.solana.com',

  // ─── Fees & Slippage ─────────────────────────
  priorityFee: parseInt(process.env.PRIORITY_FEE || '500000'),
  slippage: parseFloat(process.env.SLIPPAGE || '15'),

  // ─── Jupiter ─────────────────────────────────
  jupiterApi: process.env.JUPITER_API || 'https://quote-api.jup.ag/v6',
  jupiterApiFallback: process.env.JUPITER_API_FALLBACK || 'https://api.jup.ag/v6',

  // ─── Helius RPC ──────────────────────────────
  heliusApiKey: process.env.HELIUS_API_KEY || '',

  // ─── Trading ─────────────────────────────────
  buyAmountSol: parseFloat(process.env.BUY_AMOUNT_SOL || '0.01'),
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '2000'),
  maxOnePosition: process.env.MAX_ONE_POSITION !== 'false',
  enablePumpDirectBuy: process.env.ENABLE_PUMP_DIRECT_BUY !== 'false',

  // ─── TP / SL / Partial ───────────────────────
  tpUsd: parseFloat(process.env.TP_USD || '5.00'),
  stopLossUsd: parseFloat(process.env.STOP_LOSS_USD || '0'),        // 0 = disabled
  enablePartialTp: process.env.ENABLE_PARTIAL_TP === 'true',
  partialSellPct: parseFloat(process.env.PARTIAL_SELL_PCT || '50'), // sell X% at TP
  moonbagHoldPct: parseFloat(process.env.MOONBAG_HOLD_PCT || '25'), // hold X% after TP
  moonbagTpUsd: parseFloat(process.env.MOONBAG_TP_USD || '20'),     // sell moonbag at this TP

  // ─── Anti-Scam ───────────────────────────────
  enableAntiScam: process.env.ENABLE_ANTI_SCAM !== 'false',
  enableHoneypotCheck: process.env.ENABLE_HONEYPOT_CHECK === 'true',

  // ─── Telegram ────────────────────────────────
  telegramEnabled: process.env.TELEGRAM_ENABLED === 'true',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // ─── Curve Tracker ────────────────────────────
  enableCurveTracker: process.env.ENABLE_CURVE_TRACKER !== 'false',
  curveTargetProgress: parseFloat(process.env.CURVE_TARGET_PROGRESS || '1'),
  curveCheckInterval: parseInt(process.env.CURVE_CHECK_INTERVAL || '3000'),
  curveMaxWaitMs: parseInt(process.env.CURVE_MAX_WAIT_MS || '120000'),

  // ─── Jito ────────────────────────────────────
  enableJito: process.env.ENABLE_JITO === 'true',
  jitoTipAmount: parseFloat(process.env.JITO_TIP_AMOUNT || '0.0001'),
  jitoBlockEngine: process.env.JITO_BLOCK_ENGINE || 'https://mainnet.block-engine.jito.wtf',

  // ─── Log ─────────────────────────────────────
  logLevel: process.env.LOG_LEVEL || 'info',

  // ─── Program IDs ─────────────────────────────
  pumpProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  raydiumV4ProgramId: '675kPX9MHTjS2zt1i4bBcGvjgL2LzV3FKJ',
};

// Validate
if (!config.privateKey || config.privateKey === 'your_solana_private_key_base58_here') {
  console.error('❌ PRIVATE_KEY not set in .env file!');
  process.exit(1);
}

module.exports = config;
