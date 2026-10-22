#!/usr/bin/env python3
"""One-time helpers for the Strava connection.

  python scripts/strava_auth.py url  <client_id>                      -> prints the link the rider opens once
  python scripts/strava_auth.py token <client_id> <client_secret> <code> -> exchanges the code for a refresh token
"""
import json
import sys
import urllib.parse
import urllib.request

REDIRECT = "https://zvikinoza.github.io/ride-tracker/strava.html"


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "url":
        q = urllib.parse.urlencode({
            "client_id": sys.argv[2], "response_type": "code", "redirect_uri": REDIRECT,
            "approval_prompt": "force", "scope": "read,activity:read_all",
        })
        print(f"https://www.strava.com/oauth/authorize?{q}")
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "token":
        data = urllib.parse.urlencode({
            "client_id": sys.argv[2], "client_secret": sys.argv[3], "code": sys.argv[4], "grant_type": "authorization_code",
        }).encode()
        with urllib.request.urlopen(urllib.request.Request("https://www.strava.com/oauth/token", data=data), timeout=30) as r:
            j = json.load(r)
        ath = j.get("athlete", {})
        print(f"athlete: {ath.get('firstname', '')} {ath.get('lastname', '')} (id {ath.get('id')})", file=sys.stderr)
        print(j["refresh_token"])  # store as the STRAVA_REFRESH_TOKEN secret
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
