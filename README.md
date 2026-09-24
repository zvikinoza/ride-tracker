# Ride tracker

**Live site:** https://zvikinoza.github.io/ride-tracker/

A quiet, single-page site that shows where a cyclist is right now, the road behind them,
kilometres cycled and days on the road. Data comes from a Garmin inReach **MapShare** feed,
pulled every two hours by a GitHub Action and committed to this repo, so the site itself is
plain static files on GitHub Pages. No servers, no keys in the browser.

```
index.html, css/, js/        the site (MapLibre GL + OpenFreeMap basemap, no key, no build step)
config.json                  rider name, start date, MapShare name, demo switch
data/track.json              every tracker fix so far (grows over time)
data/summary.json            latest fix, total km, reverse-geocoded place name
data/demo-*.json             fake Tbilisi -> Istanbul data used while demo = true
scripts/fetch_track.py       pulls the KML feed, merges new points, writes summary
scripts/make_demo.py         regenerates the demo data
.github/workflows/update.yml the 2-hourly cron
```

## Setup (about 10 minutes)

1. **Turn on MapShare** on the rider's Garmin Explore account (explore.garmin.com → Social → MapShare).
   The share page is `share.garmin.com/<name>`; `<name>` is the `mapshare_id`. If they set a
   MapShare password, keep it for step 4. Make sure tracking is enabled on the device.

2. **Edit `config.json`**: `rider`, `start_date` (YYYY-MM-DD), `start_place`, `mapshare_id`,
   optional `links`. Set `"demo": false` once the real feed is connected.

3. **Create a GitHub repo** and push this folder. In *Settings → Pages* choose
   *Deploy from a branch*, branch `main`, folder `/ (root)`.

4. If the feed is password protected: *Settings → Secrets and variables → Actions → New repository
   secret* named `MAPSHARE_PASSWORD`.

5. *Actions → Update track → Run workflow* once by hand. The first run back-fills everything
   since `start_date` (in 30-day windows) and commits `data/track.json`. From then on the cron
   runs every two hours and each commit redeploys Pages automatically.

Test the fetch locally first if you like:

```bash
python3 scripts/fetch_track.py
```

## How the numbers work

- **Kilometres cycled** is the sum of straight-line distances between consecutive fixes,
  ignoring hops under 30 m (GPS jitter while stopped). A hop longer than `transfer_min_km`
  covered faster than `transfer_speed_kmh` counts as a transfer (flight, ferry, train): it is
  drawn as a dotted line and not counted. A transfer of `flight_min_km` or more is a flight: a dashed
  great-circle arc with a plane icon. Tune those values in `config.json`. Slow ferries
  can slip through; hand-edit `data/track.json` if one does.
- **Days on the road** is today minus `start_date`, inclusive.
- **Theme**: light by default, with a sun/moon toggle on the map that remembers the choice in the browser.
- **Last seen** uses the newest fix; the place name comes from OpenStreetMap Nominatim
  (one lookup per run, only when the position changed). The dot turns grey after 36 h of silence.
- The page re-reads the data every 30 minutes if left open.

## Gotchas

- GitHub disables scheduled workflows after 60 days without a human commit to the repo.
  If the map stops updating, open the Actions tab and re-enable it (any manual push also resets the clock).
- The MapShare feed only contains points the rider's MapShare settings allow (they can hide
  older tracks). Once a point is in `data/track.json` it stays there regardless.
- Feed reference: Garmin's "About inReach KML Feeds" support article; URL parameters `d1`/`d2`
  are ISO-8601 UTC timestamps.
