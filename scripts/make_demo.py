#!/usr/bin/env python3
"""Generate a plausible demo track (Tbilisi -> Istanbul) so the site has something to show
before the real feed is connected. Writes data/demo-track.json and data/demo-summary.json."""
import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
cfg = json.loads((ROOT / "config.json").read_text())
random.seed(7)

WAYPOINTS = [  # (lat, lon, name)
    (41.7151, 44.8271, "Tbilisi"), (41.9844, 44.1110, "Gori"), (41.9975, 43.5986, "Khashuri"),
    (42.2679, 42.6946, "Kutaisi"), (41.8330, 41.8010, "Kobuleti"), (41.6168, 41.6367, "Batumi"),
    (41.3906, 41.4178, "Hopa"), (41.0201, 40.5234, "Rize"), (41.0027, 39.7168, "Trabzon"),
    (40.9128, 38.3895, "Giresun"), (40.9839, 37.8764, "Ordu"), (41.2867, 36.3300, "Samsun"),
    (40.5489, 34.9533, "Çorum"), (39.9334, 32.8597, "Ankara"), (39.7767, 30.5206, "Eskişehir"),
    (40.1885, 29.0610, "Bursa"), (40.6550, 29.2769, "Yalova"),
]
FERRY_TO = (41.0082, 28.9784, "Istanbul")


def hav(a, b):
    r = 6371.0
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    s = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(s))


# Build a dense polyline with gentle wobble so it reads like roads rather than ruler lines.
line = []
for a, b in zip(WAYPOINTS, WAYPOINTS[1:]):
    n = max(2, int(hav(a, b) / 3))  # a point every ~3 km (~10 min at 18 km/h)
    amp = random.uniform(0.01, 0.03)
    phase = random.uniform(0, math.pi)
    for i in range(n):
        f = i / n
        wob = math.sin(f * math.pi * 3 + phase) * amp * math.sin(f * math.pi)
        line.append((a[0] + (b[0] - a[0]) * f + wob, a[1] + (b[1] - a[1]) * f + wob * 0.6))
line.append(WAYPOINTS[-1][:2])

start = datetime.fromisoformat(cfg["start_date"]).replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
days_avail = max(3, (now - start).days)
ride_days = max(2, int(days_avail * 0.8))  # rest one day in five
per_day = math.ceil(len(line) / ride_days)

points = []
day = 0
idx = 0
calendar = 0
while idx < len(line) and calendar < days_avail:
    if (calendar + 1) % 5 == 0:  # rest day: a couple of fixes in town
        t = start + timedelta(days=calendar, hours=11)
        p = line[idx - 1] if idx else line[0]
        for k in range(2):
            points.append({"t": (t + timedelta(hours=3 * k)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                           "lat": round(p[0] + random.uniform(-2e-4, 2e-4), 6), "lon": round(p[1] + random.uniform(-2e-4, 2e-4), 6)})
        calendar += 1
        continue
    t = start + timedelta(days=calendar, hours=random.uniform(4.5, 6))  # ~08:00 local
    for _ in range(per_day):
        if idx >= len(line):
            break
        p = line[idx]
        points.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": round(p[0], 6), "lon": round(p[1], 6), "alt": random.randint(20, 1400)})
        t += timedelta(minutes=random.uniform(9, 13))
        idx += 1
    calendar += 1

# Ferry Yalova -> Istanbul: two fixes an hour apart, flagged as a transfer by the site.
t = datetime.strptime(points[-1]["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) + timedelta(hours=16)
yal = WAYPOINTS[-1]
points.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": yal[0], "lon": yal[1], "alt": 5})  # boarding at Yalova
t += timedelta(hours=1)
points.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "lat": FERRY_TO[0], "lon": FERRY_TO[1], "alt": 12})
for k in range(1, 4):  # a few fixes rolling into the city
    points.append({"t": (t + timedelta(minutes=10 * k)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "lat": round(FERRY_TO[0] + 0.004 * k, 6), "lon": round(FERRY_TO[1] - 0.006 * k, 6), "alt": 30})

# Clamp everything so the newest fix is ~1.5 h old (a fresh-looking demo).
last = datetime.strptime(points[-1]["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
shift = (now - timedelta(hours=1.5)) - last
if abs(shift.total_seconds()) > 0:
    for p in points:
        d = datetime.strptime(p["t"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) + shift
        p["t"] = d.strftime("%Y-%m-%dT%H:%M:%SZ")

(ROOT / "data" / "demo-track.json").write_text(json.dumps({"points": points}, separators=(",", ":")) + "\n")
(ROOT / "data" / "demo-summary.json").write_text(json.dumps({
    "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "fixes": len(points), "last": points[-1], "place": "Istanbul, Türkiye"
}, indent=2) + "\n")
print(f"{len(points)} demo points written")
