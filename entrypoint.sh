#!/bin/bash
set -e

cd /home/container

# GIT_REPO: publieke repo met deze bot-code (geen geheimen IN de code — die
# staan los in de Pterodactyl Startup Variables, dus een publiek repo is hier
# geen probleem en past bij het "geen backdoors, alles inzichtelijk"-principe).
GIT_REPO="${GIT_REPO:-https://github.com/RIVINS-Labs/rivins-guardian.git}"
GIT_REF="${GIT_REF:-main}"

if [ ! -d "src" ]; then
  echo "[Guardian] Eerste installatie: clonen van ${GIT_REPO} (${GIT_REF})"
  git clone --branch "${GIT_REF}" --depth 1 "${GIT_REPO}" /tmp/guardian-src
  cp -r /tmp/guardian-src/. /home/container/
  rm -rf /tmp/guardian-src /home/container/.git
else
  echo "[Guardian] Code bijwerken (${GIT_REF})..."
  TMP=$(mktemp -d)
  git clone --branch "${GIT_REF}" --depth 1 "${GIT_REPO}" "$TMP" >/dev/null 2>&1
  rsync -a --exclude 'data' --exclude '.env' "$TMP"/ /home/container/
  rm -rf "$TMP"
fi

echo "[Guardian] Dependencies installeren..."
npm install --omit=dev

echo "[Guardian] Starten..."
exec node src/index.js
