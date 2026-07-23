// ============================================
// GMGN SNIPER — CONFIG LOADER
// ============================================
require('dotenv').config();

const config = {
  // Wallet
  privateKey: process.env.PRIVATE_KEY || '',
  publicKey: process.env.PUBLIC_KEY || '',

  // RPC
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  rpcWs: process.env.RPC_WS || 'wss://api.mainnet-beta.solana.com',

  // Fees & Slippage
  priorityFee: parseInt(process.env.PRIORITY_FEE || '500000'),
  slippage: parseFloat(process.env.SLIPPAGE || '15'),

  // Jupiter
  jupiterApi: process.env.JUPITER_API || 'https://quote-api.jup.ag/v6',

  // Trading
  tpUsd: parseFloat(process.env.TP_USD || '5.00'),
  buyAmountSol: parseFloat(process.env.BUY_AMOUNT_SOL || '0.01'),
  cooldownMs: parseInt(process.env.COOLDOWN_MS || '2000'),

  // Log
  logLevel: process.env.LOG_LEVEL || 'info',

  // Pump.fun program ID
  pumpProgramId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  raydiumV4ProgramId: '675kPX9MHTjS2zt1i4bBcGvjgL2LzV3FKJ',
};

// Validate
if (!config.privateKey || config.privateKey === 'your_solana_private_key_base58_here') {
  console.error('❌ PRIVATE_KEY not set in .env file!');
  process.exit(1);
}

module.exports = config;
