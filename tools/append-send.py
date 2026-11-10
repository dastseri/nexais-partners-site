#!/usr/bin/env python3
"""Append actual HQ send records to the PRIVATE JSONL ledger (no GitHub commit).
Usage:
  python3 tools/append-send.py --record /secure/send-from-email-center.json --out /secure/sends.jsonl
  python3 tools/append-send.py --event /secure/delivery-event.json --out /secure/sends.jsonl
The send record must have the actual full verbatim body from the sending system.
"""
import argparse, json, os, sys
from pathlib import Path
REQUIRED=("id","business_slug","business_name","stage","sent_at","channel","from","to_email","phone","subject","body_text","attachment","status","message_id","reply_note")
STAGES={"proposal","stage2","stage3","letter","other"}
STATUSES={"sent","delivered","bounced","replied"}
def lines(path):
    if not path.exists():return []
    return [json.loads(s) for s in path.read_text(encoding="utf-8").splitlines() if s.strip()]
def main():
    p=argparse.ArgumentParser(description=__doc__)
    g=p.add_mutually_exclusive_group(required=True)
    g.add_argument("--record",type=Path);g.add_argument("--event",type=Path)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    file=args.out.resolve()
    if "public" in file.parts or "assets" in file.parts or "app" in file.parts:raise SystemExit("Refusing to write private data to a public asset folder")
    obj=json.loads((args.record or args.event).read_text(encoding="utf-8"))
    if args.record:
        if any(k not in obj for k in REQUIRED):raise SystemExit("Missing required record fields")
        if obj["stage"] not in STAGES or obj["status"] not in STATUSES:raise SystemExit("Invalid stage/status")
        if not isinstance(obj["body_text"],str) or not obj["body_text"]:raise SystemExit("New sends must include FULL body_text")
        if not isinstance(obj["sent_at"],str) or not (obj["sent_at"].endswith("-05:00") or obj["sent_at"].endswith("-04:00")):raise SystemExit("sent_at must include Toronto offset")
        current=lines(file)
        if any(x.get("id")==obj["id"] or (obj.get("message_id") and x.get("message_id")==obj["message_id"]) for x in current):
            print("No changes: duplicate id/message_id");return
        target=file
    else:
        if not obj.get("send_id") or obj.get("status") not in STATUSES or not obj.get("at"):raise SystemExit("Invalid status event")
        if not any(x.get("id")==obj["send_id"] for x in lines(file)):raise SystemExit("Unknown send_id")
        target=file.with_name("send-status-events.jsonl")
        if any(x.get("event_id") and x.get("event_id")==obj.get("event_id") for x in lines(target)):
            print("No changes: duplicate event_id");return
    target.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
    try:
        with os.fdopen(fd,"a",encoding="utf-8") as f:
            f.write(json.dumps(obj,ensure_ascii=False,separators=(",",":"))+"\n")
            f.flush();os.fsync(f.fileno())
    finally:pass
    print("Appended securely:",target.name)
if __name__=="__main__":main()
