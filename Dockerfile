# RIVINS Guardian — Pterodactyl-image
# Geen MongoDB nodig (SQLite, één lokaal bestand), dus geen tweede proces
# in deze container en geen extra database-service om af te schermen.

FROM node:20-bullseye-slim

# git nodig omdat het entrypoint-script bij elke start de nieuwste code
# pullt uit JOUW EIGEN repo (zie entrypoint.sh) — geen extern project,
# dus geen supply-chain-risico van een derde partij.
RUN apt-get update && apt-get install -y git python3 make g++ ca-certificates rsync \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/container
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER root
CMD ["/entrypoint.sh"]
