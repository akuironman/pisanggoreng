#!/usr/bin/env bash
# ============================================
# PISANGGORENG SETUP — One-command setup
# ============================================
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   🍳 PISANGGORENG SETUP                  ║"
echo "║   GMGN Sniper Bot — One-command setup    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found! Install from https://nodejs.org"
  exit 1
fi
echo "✅ Node.js $(node -v)"
echo "✅ npm $(npm -v)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Create .env from example if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ Created .env file from .env.example"
  echo "⚠️  EDIT .env with your PRIVATE_KEY before running!"
else
  echo "✅ .env already exists"
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   ✅ SETUP COMPLETE                       ║"
echo "║                                          ║"
echo "║   ▶️  EDIT .env — isi PRIVATE_KEY lo       ║"
echo "║   ▶️  RUN:  node bot.js                    ║"
echo "╚══════════════════════════════════════════╝"
echo ""
