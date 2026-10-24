#!/usr/bin/env python3
"""One-time import of calls logged in the hub before cutover (Google Sheet "NexAIS Hub
Activity Log" → Activity tab, downloaded as CSV) into CRM partner_activity_log rows on the
imported missions.

Cleans what the device log produces while people type and click:
  - exact duplicate rows (the Sheet sync can send an entry twice) are dropped;
  - notes saved while typing: only the final note of each typing burst is kept;
  - status clicks within 2 minutes collapse into one change (first "from" -> last "to");
  - test rows are dropped.
The typed name is mapped to a CRM user id with a JSON file ({"Sogol": "<uuid>"}); unmapped
names are kept in the note. Output SQL is idempotent and must be run by an admin session
(service role / SQL editor) after the 57-card import, because only trusted sessions may keep
the original person and device time.
Usage: python3 tools/import-sheet-activity.py activity.csv names.json COMPANY_ID OUT_DIR
"""
import csv, json, re, sys
from datetime import datetime, timedelta
from pathlib import Path

OUTCOMES = {'Not called': 'not_called', 'Reached decision-maker': 'reached_decision_maker', 'Gatekeeper': 'gatekeeper',
            'Voicemail left': 'voicemail_left', 'Not interested': 'not_interested', 'Callback scheduled': 'callback_scheduled',
            'Demo booked': 'demo_booked'}
ACTIONS = {'Call': 'call', 'SMS': 'sms', 'Email': 'email', 'DM': 'note', 'Visit': 'visit'}


def when(value):
    v = (value or '').strip()
    for fmt in ('%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ'):
        try:
            return datetime.strptime(v, fmt)
        except ValueError:
            pass
    m = re.match(r'(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) (EDT|EST)', v)
    if m:
        base = datetime.strptime(f'{m.group(1)} {m.group(2)}:{m.group(3)}', '%Y-%m-%d %H:%M')
        return base + timedelta(hours=4 if m.group(4) == 'EDT' else 5)
    return None


def clean(rows):
    seen, out = set(), []
    for r in rows:
        key = tuple((r.get(k) or '').strip() for k in ('When', 'By', 'Business', 'What', 'From', 'To'))
        if key in seen:
            continue
        seen.add(key)
        if r.get('What') not in ('status', 'notes', 'action') or 'TEST' in (r.get('Business') or ''):
            continue
        t = when(r.get('When'))
        if not t:
            continue
        out.append({'at': t, 'by': r['By'].strip(), 'business': r['Business'].strip(), 'what': r['What'],
                    'from': (r.get('From') or '').strip(), 'to': (r.get('To') or '').strip()})
    out.sort(key=lambda x: x['at'])
    final = []
    for e in out:
        prev = next((p for p in reversed(final) if p['by'] == e['by'] and p['business'] == e['business'] and p['what'] == e['what']), None)
        if e['what'] == 'notes' and prev and e['at'] - prev['at'] <= timedelta(minutes=10):
            final.remove(prev)                       # keep only the last note of a typing burst
        if e['what'] == 'status' and prev and e['at'] - prev['at'] <= timedelta(minutes=2):
            final.remove(prev)
            e = dict(e, **{'from': prev['from']})    # first "from" -> last "to"
            if e['from'] == e['to']:
                continue
        final.append(e)
    return final


def lit(v):
    return 'null' if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    csv_path, names_path, company, out_dir = sys.argv[1:5]
    names = json.loads(Path(names_path).read_text(encoding='utf-8'))
    with open(csv_path, newline='', encoding='utf-8') as f:
        entries = clean(list(csv.DictReader(f)))
    lines = ['-- One-time import of pre-cutover hub activity (Google Sheet). Idempotent. Run as admin after the card import.', 'begin;']
    unmatched = []
    for e in entries:
        prefix = re.sub(r'[^A-Za-z0-9]+', '', e['business']).lower()
        actor = names.get(e['by'])
        marker = f"[imported from hub sheet · typed name: {e['by']} · device time: {e['at'].isoformat()}Z]"
        if e['what'] == 'status':
            action, outcome, frm, to, note = 'call', OUTCOMES.get(e['to']), e['from'] or None, e['to'], marker
            if not outcome:
                unmatched.append(e); continue
        elif e['what'] == 'notes':
            action, outcome, frm, to, note = 'note', None, None, None, f"{e['to']} {marker}"
        else:
            action = ACTIONS.get(e['to'])
            if not action:
                unmatched.append(e); continue
            outcome, frm, to, note = None, None, e['to'], marker
        lines.append(
            'insert into public.partner_activity_log (company_id, mission_id, actor_user, action, outcome, from_value, to_value, notes, created_at) '
            f"select {lit(company)}, m.id, {lit(actor)}, {lit(action)}, {lit(outcome)}, {lit(frm)}, {lit(to)}, {lit(note)}, {lit(e['at'].isoformat() + 'Z')} "
            f"from public.partner_missions m where m.company_id = {lit(company)} and m.dedupe_key like {lit(prefix + '|%')} "
            "and m.status not in ('won','lost','closed','rejected') "
            f"and not exists (select 1 from public.partner_activity_log a where a.mission_id = m.id and a.notes = {lit(note)}) limit 1;")
    lines.append('commit;')
    out = Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    (out / 'sheet-activity.sql').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'kept_entries': len(entries), 'unmatched': [f"{u['business']} {u['what']} {u['to']}" for u in unmatched],
                      'people': sorted({e['by'] for e in entries}), 'unmapped_people': sorted({e['by'] for e in entries} - set(names))},
                     ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
