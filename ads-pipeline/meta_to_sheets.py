"""Pull daily ad-level insights from the Meta Marketing API into a Google Sheet.

Environment variables:
  META_ACCESS_TOKEN   System User token with ads_read (never commit or paste it)
  META_AD_ACCOUNT_ID  Ad account id, with or without the "act_" prefix
  SHEET_ID            Google Sheet id (sheet must be shared with the runtime service account)
  SHEET_TAB           Tab name (default: meta_daily)
  LOOKBACK_DAYS       Days to re-fetch each run (default: 30). Meta restates recent
                      data (attribution, late conversions), so the window is replaced, not appended.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import date, timedelta

import requests

API_VERSION = "v21.0"
BASE_URL = f"https://graph.facebook.com/{API_VERSION}"
WINDOWS = ("7d_click", "1d_view")
PURCHASE_TYPES = ("omni_purchase", "purchase")

FIELDS = [
    "date_start", "campaign_id", "campaign_name", "adset_id", "adset_name",
    "ad_id", "ad_name", "spend", "impressions", "reach", "clicks",
    "inline_link_clicks", "actions", "action_values",
]

COLUMNS = [
    "date", "campaign_id", "campaign_name", "adset_id", "adset_name",
    "ad_id", "ad_name", "spend", "impressions", "reach", "clicks",
    "link_clicks",
    "purchases_7d_click", "purchase_value_7d_click",
    "purchases_1d_view", "purchase_value_1d_view",
]


def _purchase_total(items: list[dict] | None, window: str) -> float:
    """Value for the purchase action type, per attribution window."""
    if not items:
        return 0.0
    by_type = {i["action_type"]: i for i in items}
    for action_type in PURCHASE_TYPES:
        if action_type in by_type:
            return float(by_type[action_type].get(window, 0) or 0)
    return 0.0


def transform(row: dict) -> list:
    actions, values = row.get("actions"), row.get("action_values")
    return [
        row["date_start"], row.get("campaign_id"), row.get("campaign_name"),
        row.get("adset_id"), row.get("adset_name"), row.get("ad_id"), row.get("ad_name"),
        float(row.get("spend", 0) or 0), int(row.get("impressions", 0) or 0),
        int(row.get("reach", 0) or 0), int(row.get("clicks", 0) or 0),
        int(row.get("inline_link_clicks", 0) or 0),
        _purchase_total(actions, "7d_click"), _purchase_total(values, "7d_click"),
        _purchase_total(actions, "1d_view"), _purchase_total(values, "1d_view"),
    ]


def _get(url: str, params: dict | None = None, retries: int = 5) -> dict:
    for attempt in range(retries):
        resp = requests.get(url, params=params, timeout=60)
        if resp.status_code == 200:
            return resp.json()
        # Rate limit / transient errors: back off and retry
        if resp.status_code in (429, 500, 502, 503) or resp.json().get("error", {}).get("code") in (4, 17, 32, 613):
            time.sleep(2 ** attempt * 5)
            continue
        raise RuntimeError(f"Meta API error {resp.status_code}: {resp.text}")
    raise RuntimeError("Meta API: retries exhausted")


def fetch_insights(token: str, account_id: str, since: date, until: date) -> list[dict]:
    account = account_id if account_id.startswith("act_") else f"act_{account_id}"
    params = {
        "access_token": token,
        "level": "ad",
        "time_increment": 1,
        "time_range": json.dumps({"since": since.isoformat(), "until": until.isoformat()}),
        "fields": ",".join(FIELDS),
        "action_attribution_windows": json.dumps(list(WINDOWS)),
        "limit": 500,
    }
    rows: list[dict] = []
    payload = _get(f"{BASE_URL}/{account}/insights", params)
    while True:
        rows.extend(payload.get("data", []))
        next_url = payload.get("paging", {}).get("next")
        if not next_url:
            return rows
        payload = _get(next_url)  # next_url already carries all params


def merge_rows(existing: list[list], new: list[list], since: date, until: date) -> list[list]:
    """Keep rows outside [since, until]; replace everything inside it with `new`."""
    kept = [r for r in existing if not (since.isoformat() <= str(r[0]) <= until.isoformat())]
    merged = kept + new
    merged.sort(key=lambda r: (str(r[0]), str(r[1]), str(r[3]), str(r[5])))
    return merged


def write_sheet(sheet_id: str, tab: str, new_rows: list[list], since: date, until: date) -> int:
    import google.auth
    import gspread

    creds, _ = google.auth.default(scopes=[
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
    ])
    book = gspread.authorize(creds).open_by_key(sheet_id)
    try:
        ws = book.worksheet(tab)
    except gspread.WorksheetNotFound:
        ws = book.add_worksheet(title=tab, rows=1000, cols=len(COLUMNS))

    # Numeric values are read back as numbers; ids as strings (kept as text below)
    existing = ws.get_all_values()[1:]
    merged = merge_rows(existing, new_rows, since, until)
    ws.clear()
    ws.update(range_name="A1", values=[COLUMNS] + merged, value_input_option="RAW")
    return len(merged)


def main() -> int:
    token = os.environ["META_ACCESS_TOKEN"]
    account_id = os.environ["META_AD_ACCOUNT_ID"]
    sheet_id = os.environ["SHEET_ID"]
    tab = os.environ.get("SHEET_TAB", "meta_daily")
    lookback = int(os.environ.get("LOOKBACK_DAYS", "30"))

    until = date.today() - timedelta(days=1)  # yesterday: today's data is incomplete
    since = until - timedelta(days=lookback - 1)

    raw = fetch_insights(token, account_id, since, until)
    new_rows = [transform(r) for r in raw]
    total = write_sheet(sheet_id, tab, new_rows, since, until)
    print(f"Fetched {len(new_rows)} rows for {since}..{until}; sheet now holds {total} rows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
