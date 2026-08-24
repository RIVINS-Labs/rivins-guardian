# RIVINS Guardian

Zelfgebouwde, self-hosted Discord-moderatiebot voor RIVINSlive. Gemaakt naar
aanleiding van de DeathWish-raid (24 aug 2026) — specifiek om het soort
handmatig speurwerk dat toen nodig was (audit log doorpluizen, webhook-
anomalieën natrekken) voortaan automatisch te laten gebeuren.

## Uitgangspunten ("geen backdoors")

- **Alle code staat hier, letterlijk.** Niets draait "onder de motorkap" dat
  niet in dit repo staat. Geen externe telemetry-calls, geen
  phone-home naar een derde partij, geen verborgen master-account.
- **Eén uitzondering, expliciet zichtbaar:** `OWNER_ID` in `.env` krijgt een
  uitzondering op de protection-thresholds (zodat jouw eigen legitieme bulk-
  acties geen vals alarm triggeren) — maar wordt nog steeds gewoon gelogd.
  Zoek naar `isOwner` in `src/modules/adminAbuseDetection.js` als je wilt
  zien exact wat dat wel/niet betekent.
- **Automatische acties zijn bewust minimaal.** Standaard doet dit systeem
  alleen loggen + alarmeren. Alleen als je zelf `STRICT_MODE=true` zet, kan
  het systeem gevaarlijke rollen (Administrator, Ban Members, Manage
  Webhooks, Manage Roles) tijdelijk van een verdachte actor afpakken — nooit
  automatisch bannen/kicken, dat besluit blijft bij een mens.
- **Geen MongoDB, geen losse database-service.** Alles lokaal in SQLite
  (`data/guardian.sqlite`), zelfde filosofie als `armastatus.php`.

## Modules

| Module | Bestand | Doet |
|---|---|---|
| Anti-spam | `src/modules/antiSpam.js` | Message-flooding, duplicate-berichten, mass-mentions, invite+@everyone-combinatie |
| Anti-raid | `src/modules/antiRaid.js` | Join-spikes, nieuwe-account-detectie, **verdachte webhook-activiteit** (het DeathWish-scenario) |
| Logging | `src/modules/logging.js` | Volledige audit-trail: deletes, edits, joins, bans, rolwijzigingen |
| Admin-abuse-detectie | `src/modules/adminAbuseDetection.js` | Bewaakt de Discord Audit Log zelf op verdachte patronen door staff/admins |
| Dashboard | `src/dashboard/` | Read-only webinterface, Discord-login, alleen toegestane user-ID's |

## Lokaal testen

```bash
cp .env.example .env
# vul .env in — zie de comments per variabele

npm install
npm start          # start de bot
npm run dashboard  # los proces, start het dashboard op DASHBOARD_PORT
```

## Deployen op Pterodactyl (`gamepanel.rivinshosting.com`)

1. **Push deze code naar je eigen private repo** (bv.
   `RIVINS-Labs/rivins-guardian`, zelfde patroon als `rivins-surveillance`).
   Dit is belangrijk: de egg pullt straks van dít repo, dus alleen code die
   *jij* hebt gepusht draait ooit op de server.
2. Bouw het Docker-image (`Dockerfile` in deze map) en push naar een
   registry (Docker Hub of GHCR, mag privé).
3. Nieuwe egg aanmaken in het paneel met dat image.
4. Startup Variables invullen (zie `.env.example` voor de volledige lijst,
   plus `GIT_REPO` en `GIT_REF` uit `entrypoint.sh`).
5. Persistente volume zorgt dat `data/guardian.sqlite` en `.env` een
   herstart overleven — de rest van de code wordt bij elke start ververst
   vanuit je eigen repo.

### Updaten

Omdat dit jouw eigen repo is (niet een extern project), is automatisch
updaten hier veilig: gewoon naar `GIT_REF` (main of een tag) pushen, en bij
de volgende herstart van de server haalt `entrypoint.sh` dat automatisch
op. Wil je liever bewust per versie updaten in plaats van altijd de nieuwste
`main`: zet `GIT_REF` op een specifieke tag (bv. `v1.0.0`) en bump die
handmatig wanneer je wilt updaten.

## Nog niet gebouwd / volgende stappen

Dit is een werkende eerste versie, geen kant-en-klaar eindproduct. Dingen
die je waarschijnlijk nog wilt toevoegen naarmate je het gebruikt:

- Slash-commands voor handmatige acties (`/guardian status`, `/guardian mute`)
- Configuratie via het dashboard in plaats van alleen `.env`
  (nu moet je voor elke instelling de server herstarten)
- Automatische message-delete bij anti-spam-triggers (bewust nog uit, zie
  de comment in `src/index.js`)
- Rate-limiting per rol i.p.v. alleen exempt/niet-exempt
- Discord slash-command `/guardian export` voor een CSV-export vanuit het
  dashboard voor archivering
