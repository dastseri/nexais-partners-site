#!/usr/bin/env python3
"""Build the one-time import of the hub's call cards into CRM partner missions.

Reads index.html, extracts one mission per card, and writes:
  - <out>/hub-cards.json   reviewable list
  - <out>/hub-cards.sql    idempotent INSERT for the NexAIS company (skips businesses
                           that already have an open mission), run by an admin on cutover day.
No database access here. Personal contact names stay in partner_summary, which only the
team and the assigned partner can read under CRM row-level security.
Usage: python3 tools/import-hub-cards.py index.html OUT_DIR COMPANY_ID
"""
import html, json, re, sys
from pathlib import Path

GROUPS = {'1': 'Priority 1 — named contacts', '2': 'Restaurants & venues', '3': 'Clinics & spas', 't': 'Transport & logistics'}

def text(fragment):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', fragment or ''))).strip()

def first(pattern, block):
    m = re.search(pattern, block, re.S)
    return m.group(1) if m else None

def parse(src):
    out = []
    for m in re.finditer(r'<article class="card"([^>]*)>(.*?)</article>', src, re.S):
        attrs, body = m.group(1), m.group(2)
        name = text(first(r'<h4>(.*?)</h4>', body) or '')
        name = re.sub(r'^\d+\s*', '', name)
        group = first(r'data-group="([^"]+)"', attrs) or ''
        facts = {text(k): v for k, v in re.findall(r'<dt>(.*?)</dt>\s*<dd[^>]*>(.*?)</dd>', body, re.S)}
        tel = first(r'href="tel:([^"]+)"', body)
        phone = text(facts.get('Phone', '')) or (tel or '')
        proposal = first(r'<p class="prop-link"><a href="(https://[^"]+)"', body)
        hook = text(first(r'<p class="hook">(.*?)</p>', body) or '')
        ask = text(facts.get('Ask for', ''))
        sent = text(facts.get('Proposal sent', ''))
        summary = ' | '.join(x for x in [f'Ask for: {ask}' if ask else '', hook, f'Proposal sent: {sent}' if sent else ''] if x)
        out.append({
            'business_name': name,
            'city': text(first(r'<p class="loc">(.*?)</p>', body) or '') or None,
            'vertical': GROUPS.get(group, group or None),
            'public_phone': phone or None,
            'website': (first(r'<dt>Website</dt>\s*<dd[^>]*>.*?href="(https?://[^"]+)"', body) or None),
            'partner_summary': summary[:3800] or None,
            'proposal_link': proposal,
        })
    return out

def dedupe_key(name, phone):
    return re.sub(r'[^A-Za-z0-9]+', '', name).lower() + '|' + re.sub(r'[^0-9]+', '', phone or '')

def sql_literal(v):
    return 'null' if v is None else "'" + str(v).replace("'", "''") + "'"

def main():
    src, out_dir, company = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
    rows = parse(Path(src).read_text(encoding='utf-8'))
    seen, unique, dupes = set(), [], []
    for r in rows:
        k = dedupe_key(r['business_name'], r['public_phone'])
        (dupes if k in seen else unique).append(r); seen.add(k)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'hub-cards.json').write_text(json.dumps(unique, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['-- One-time import of hub call cards into partner_missions (NexAIS). Idempotent.',
             '-- Run as an admin session on cutover day after review. Origin: system_initiated, status: approved.',
             'begin;']
    for r in unique:
        cols = ['company_id', 'origin', 'status', 'business_name', 'city', 'vertical', 'public_phone', 'website', 'partner_summary', 'proposal_link', 'research_ref']
        vals = [sql_literal(company), "'system_initiated'", "'approved'"] + [sql_literal(r[c]) for c in cols[3:10]] + ["'partner-hub card import 2026-10'"]
        lines.append(f"insert into public.partner_missions ({', '.join(cols)}) select {', '.join(vals)} "
                     f"where not exists (select 1 from public.partner_missions m where m.company_id = {sql_literal(company)} "
                     f"and m.dedupe_key = {sql_literal(dedupe_key(r['business_name'], r['public_phone']))} "
                     f"and m.status not in ('won','lost','closed','rejected'));")
    lines.append('commit;')
    (out_dir / 'hub-cards.sql').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({'cards': len(rows), 'unique_missions': len(unique), 'duplicates_in_hub': [d['business_name'] for d in dupes],
                      'with_phone': sum(1 for r in unique if r['public_phone']), 'with_proposal': sum(1 for r in unique if r['proposal_link']),
                      'by_vertical': {v: sum(1 for r in unique if r['vertical'] == v) for v in sorted({r['vertical'] for r in unique if r['vertical']})}},
                     ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()
