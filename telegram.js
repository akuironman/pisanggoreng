// ============================================
// PISANGGORENG v2.0 — TELEGRAM NOTIFIER
// ============================================
// Sends trade alerts, TP hits, errors to Telegram
// ============================================
// Node 22 built-in fetch

class TelegramNotifier {
  constructor(config) {
    this.enabled = config.enabled;
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.useMarkdown = config.useMarkdown !== false;
  }

  async sendMessage(text, parseMode = 'Markdown') {
    if (!this.enabled || !this.botToken || !this.chatId) {
      return false;
    }

    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: text,
            parse_mode: this.useMarkdown ? parseMode : undefined,
            disable_web_page_preview: true,
          }),
        }
      );
      const data = await resp.json();
      if (!data.ok) {
        console.warn(`[Telegram] API error: ${data.description}`);
        return false;
      }
      return true;
    } catch (e) {
      console.warn(`[Telegram] Send failed: ${e.message}`);
      return false;
    }
  }

  /** Bot started */
  async onStart(config) {
    if (!this.enabled) return;
    const msg = [
      `🚀 *PISANGGORENG SNIPER BOT v2.0*`,
      ``,
      `👛 Wallet: \`${config.walletAddress}\``,
      `💰 Balance: ${config.balanceSol} SOL ($${config.balanceUsd})`,
      `🎯 TP: $${config.tpUsd} | SL: $${config.stopLossUsd}`,
      `💸 Buy: ${config.buyAmountSol} SOL | Slippage: ${config.slippage}%`,
      `🛡️ Anti-scam: ${config.antiScam ? 'ON' : 'OFF'}`,
      `📊 Partial TP: ${config.partialTp ? `Sell ${config.partialSellPct}% at TP, moonbag rest` : 'OFF'}`,
      `📡 RPC: ${config.rpcEndpoint.slice(0, 40)}...`,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** Buy executed */
  async onBuy(mint, tokenAmount, solAmount, entryPriceUsd, txSig, filterInfo) {
    if (!this.enabled) return;
    const mintShort = mint.slice(0, 8) + '...';
    const msg = [
      `🟢 *BUY EXECUTED*`,
      ``,
      `🔹 Token: \`${mintShort}\`${filterInfo ? ` | ✅ ${filterInfo}` : ''}`,
      `🔹 Amount: ${tokenAmount.toFixed(4)} tokens`,
      `🔹 Cost: ${solAmount} SOL ($${(solAmount * entryPriceUsd / tokenAmount).toFixed(2)})`,
      `🔹 Entry: $${(entryPriceUsd / tokenAmount / 2 * 2).toFixed(8)}`,
      ``,
      `🔗 [Solscan](https://solscan.io/tx/${txSig})`,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** TP hit */
  async onTpHit(mint, profitUsd, profitPct, totalValueUsd) {
    if (!this.enabled) return;
    const mintShort = mint.slice(0, 8) + '...';
    const msg = [
      `🟢 *PARTIAL TP HIT — $${profitUsd.toFixed(2)}* 🎯`,
      ``,
      `🔹 Token: \`${mintShort}\``,
      `🔹 Profit: *$${profitUsd.toFixed(2)}* (${profitPct.toFixed(1)}%)`,
      `🔹 Value: $${totalValueUsd.toFixed(2)}`,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** Position fully sold */
  async onSell(mint, profitUsd, profitPct, totalSolReturned, txSig) {
    if (!this.enabled) return;
    const mintShort = mint.slice(0, 8) + '...';
    const emoji = profitUsd >= 0 ? '🟢' : '🔴';
    const msg = [
      `${emoji} *POSITION CLOSED*`,
      ``,
      `🔹 Token: \`${mintShort}\``,
      `🔹 PnL: *${profitUsd >= 0 ? '+' : ''}$${profitUsd.toFixed(2)}* (${profitPct.toFixed(1)}%)`,
      `🔹 Returned: ${totalSolReturned.toFixed(6)} SOL`,
      ``,
      `🔗 [Solscan](https://solscan.io/tx/${txSig})`,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** Anti-scam block */
  async onScamBlock(mint, reason) {
    if (!this.enabled) return;
    const mintShort = mint.slice(0, 8) + '...';
    const msg = [
      `🔴 *ANTI-SCAM BLOCKED* 🛡️`,
      ``,
      `🔹 Token: \`${mintShort}\``,
      `🔹 Reason: ${reason}`,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** Error alert */
  async onError(context, errorMsg) {
    if (!this.enabled) return;
    const msg = [
      `⚠️ *BOT ERROR*`,
      ``,
      `🔹 Context: ${context}`,
      `🔹 Error: \`${errorMsg.slice(0, 200)}\``,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** Daily summary */
  async onDailySummary(stats) {
    if (!this.enabled) return;
    const msg = [
      `📊 *DAILY SUMMARY*`,
      ``,
      `🔹 Trades: ${stats.totalTrades}`,
      `🔹 TP Hit: ${stats.tpHit}`,
      `🔹 SL Hit: ${stats.slHit}`,
      `🔹 Scams Blocked: ${stats.scamsBlocked}`,
      `🔹 PnL: *${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}*`,
      `🔹 Balance: ${stats.balanceSol.toFixed(4)} SOL ($${stats.balanceUsd.toFixed(2)})`,
    ].join('\n');
    await this.sendMessage(msg);
  }

  /** Closed trade summary */
  async onTradeSummary(trades) {
    if (!this.enabled || trades.length === 0) return;
    const totalPnL = trades.reduce((s, t) => s + (t.profitUsd || 0), 0);
    const wins = trades.filter(t => (t.profitUsd || 0) > 0).length;
    const losses = trades.filter(t => (t.profitUsd || 0) <= 0).length;
    const msg = [
      `📊 *TRADE SESSION SUMMARY*`,
      ``,
      `🔹 Total Closed: ${trades.length}`,
      `🔹 Wins: ${wins} | Losses: ${losses}`,
      `🔹 Win Rate: ${trades.length > 0 ? (wins / trades.length * 100).toFixed(0) : 0}%`,
      `🔹 Total PnL: *${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}*`,
    ].join('\n');
    await this.sendMessage(msg);
  }
}

module.exports = TelegramNotifier;
