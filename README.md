# Arkea Arena Availability Watcher

Small local Node.js watcher for an Arkea Arena event page. It finds the ticketing link from the concert presentation page, derives the ticketing API URL, bootstraps the session cookies the site expects with `fetch`, reads the tariff response behind the seat map, and sends a Discord webhook message when watched availability drops or one of its zones disappears from the available map options.

## Setup

1. Copy `.env.example` to `.env`.
2. Put your real Discord webhook URL in `.env`.
3. Start the watcher:

```powershell
.\start-watcher.ps1
```

The first run creates `state.json` and does not notify unless `DISCORD_NOTIFY_ON_START=1`.

## Docker

Build locally:

```powershell
docker build -t arkea-arena-watcher .
```

Run with your `.env` file:

```powershell
docker run --rm --env-file .env arkea-arena-watcher
```

After the GitHub Actions workflow runs on `main`, the image is published to:

```text
ghcr.io/jul-fls/arkea-arena-watcher:latest
```

Run the published image:

```powershell
docker run --rm --env-file .env ghcr.io/jul-fls/arkea-arena-watcher:latest
```

## Docker Compose

Copy `.env.example` to `.env`, set your webhook and event URL, then run:

```powershell
docker compose up -d
```

Compose uses the published GHCR image and stores `state.json` plus `session.json` in a named volume.

Useful commands:

```powershell
docker compose logs -f watcher
docker compose pull
docker compose up -d
docker compose down
```

If an older deployment created the volume with the wrong ownership and logs show `EACCES: permission denied, open '/data/state.json'`, recreate the volume once:

```powershell
docker compose down -v
docker compose up -d
```

## Configuration

- `DISCORD_WEBHOOK_URL`: required Discord webhook URL.
- `PRESENTATION_URL`: Arkea Arena concert presentation page; the watcher finds the ticketing URL from this.
- `WATCH_URL`: optional direct ticketing URL override.
- `API_URL`: optional direct tariff API URL override.
- `RECAPTCHA_SITE_KEY`: optional override; normally discovered from the ticketing EPS asset at runtime.
- `POLL_SECONDS`: polling interval, default `180`.
- `WATCH_CATEGORIES`: comma-separated categories to watch, default `01,02,FO`.
- `DISCORD_NOTIFY_ON_START`: set to `1` to send a startup message.
- `SESSION_FILE`: cookie/session cache, default `session.json`.
- `RUN_ONCE`: set to `1` for a single poll smoke test.

No npm packages are required. The script uses the built-in `fetch` available in modern Node.js.

## What It Watches

The watcher tracks these ticketing API categories by default:

- `01`: `CATEGORIE 1`, shown as red dots in the seat map UI.
- `02`: `CATEGORIE 2`, shown as green dots in the seat map UI.
- `FO`: `FOSSE`, shown as the blue floor rectangle in the seat map UI.

Unavailable white map dots are not counted by the API category totals; the script watches the available colored inventory reported by the backend.

Default presentation page example:

https://www.arkeaarena.com/evenements/electric-callboy-en-concert-30-janvier-2027-billetterie-bordeaux

Discovered ticketing URL example:

https://billetterie.arkeaarena.com/fr/manifestation/electric-callboy-billet/idmanif/659872/idseance/4340678/codtypadh/PRM/numadh/01/codeconf/promo01

On each poll it stores totals per category and per zone in `state.json`. Discord messages include:

- event metadata discovered from the presentation page and ticketing API
- total watched availability
- category totals for Catégorie 1, Catégorie 2, and Fosse
- zone-level drops, when the backend exposes zones for that category

When `PRESENTATION_URL` or `WATCH_URL` points to a different event, the watcher detects the changed event fingerprint and resets the saved availability baseline automatically. The next poll becomes the new baseline instead of comparing the new concert with the old one.
