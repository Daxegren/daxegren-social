import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import meta_to_sheets as m  # noqa: E402


def sample(**over):
    row = {
        "date_start": "2026-11-01", "campaign_id": "1", "campaign_name": "RC | Prospecting | Adv+",
        "adset_id": "2", "adset_name": "as", "ad_id": "3", "ad_name": "ad",
        "spend": "300.18", "impressions": "4000", "reach": "3000", "clicks": "90",
        "inline_link_clicks": "70",
        "actions": [
            {"action_type": "link_click", "7d_click": "70"},
            {"action_type": "omni_purchase", "7d_click": "2", "1d_view": "1"},
        ],
        "action_values": [{"action_type": "omni_purchase", "7d_click": "5800.5", "1d_view": "2900"}],
    }
    row.update(over)
    return row


def test_transform_purchases_and_values():
    out = m.transform(sample())
    assert len(out) == len(m.COLUMNS)
    d = dict(zip(m.COLUMNS, out))
    assert d["spend"] == 300.18
    assert d["purchases_7d_click"] == 2 and d["purchases_1d_view"] == 1
    assert d["purchase_value_7d_click"] == 5800.5 and d["purchase_value_1d_view"] == 2900


def test_transform_no_purchases():
    d = dict(zip(m.COLUMNS, m.transform(sample(actions=None, action_values=None))))
    assert d["purchases_7d_click"] == 0 and d["purchase_value_7d_click"] == 0


def test_transform_falls_back_to_purchase_type():
    row = sample(actions=[{"action_type": "purchase", "7d_click": "4"}])
    assert dict(zip(m.COLUMNS, m.transform(row)))["purchases_7d_click"] == 4


def test_merge_replaces_window_and_keeps_history():
    old = [["2026-09-30", "1", "c", "2", "a", "3", "x"], ["2026-10-15", "1", "c", "2", "a", "3", "x"]]
    new = [["2026-10-15", "1", "c", "2", "a", "3", "NEW"], ["2026-10-16", "1", "c", "2", "a", "3", "NEW"]]
    merged = m.merge_rows(old, new, date(2026, 10, 1), date(2026, 10, 31))
    assert [r[0] for r in merged] == ["2026-09-30", "2026-10-15", "2026-10-16"]
    assert merged[1][6] == "NEW"
