#!/usr/bin/env python3
"""Import real Jarvis Hub 'مکاتبات' exports into private append-only sends.jsonl.
No mock data, no Sheet modifications. Full body is loaded only from a matched raw .eml.
Usage:
  python3 tools/import-sends.py --csv /secure/jarvis-correspondence.csv --eml-dir /secure/sent-eml --out /secure/sends.jsonl
  python3 tools/import-sends.py --xlsx /secure/jarvis-hub.xlsx --out /secure/sends.jsonl
CSV: export the actual Google Sheet tab "مکاتبات" as UTF-8 CSV. Optional --mirror markdown table.
"""
import argparse, csv, hashlib, json, re, sys, unicodedata
from datetime import datetime, date, time, timedelta
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from zoneinfo import ZoneInfo

TORONTO = ZoneInfo("America/Toronto")
REPO = Path(__file__).resolve().parents[1]
COLS = ("تاریخ", "بخش", "طرف مکاتبه", "جهت", "خلاصه", "کانال / لینک", "وضعیت")
EMAIL = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
MSGID = re.compile(r"(?:\bmsg\s+|\bmessage[_ -]?id[: =]+)([a-f\d]{10,}|<[^>]+>)", re.I)
EMLNAME = re.compile(r"[\w.\-]+\.eml", re.I)
PDFNAME = re.compile(r"[\w.\-]+\.pdf", re.I)
TIME = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\s*(EST|EDT)?\b", re.I)

def normal(value):
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"[^a-z0-9]+", "", value.lower())

def slug(value):
    val = unicodedata.normalize("NFKD", str(value or ""))
    val = "".join(ch for ch in val if not unicodedata.combining(ch))
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", val.lower())).strip("-") or "business"

class CardParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cards, self.active, self.h4, self.phone = {}, None, False, False
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "article" and "card" in a.get("class", "").split():
            self.active = {"name":"", "slug": a.get("data-business-slug", ""), "phone":""}
        if self.active is not None and tag == "h4": self.h4 = True
        if self.active is not None and tag == "a" and a.get("href", "").startswith("tel:"):
            self.phone = True
            self.active["tel"] = a["href"][4:]
    def handle_data(self, data):
        if self.active is None: return
        if self.h4: self.active["name"] += data
        if self.phone: self.active["phone"] += data
    def handle_endtag(self, tag):
        if tag == "h4": self.h4 = False
        if tag == "a": self.phone = False
        if tag == "article" and self.active:
            name = re.sub(r"^\s*\d+\s*", "", self.active["name"]).strip()
            self.active["name"] = name
            if name: self.cards[normal(name)] = self.active
            self.active = None

def cards_from_html(index_path):
    if not index_path.exists(): return {}
    p=CardParser()
    p.feed(index_path.read_text(encoding="utf-8"))
    return p.cards

def parse_date(raw):
    value = str(raw or "").strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%d/%m/%Y"):
        try: return datetime.strptime(value[:10], fmt).date()
        except ValueError: pass
    return None

def parse_time(day, note):
    match = TIME.search(str(note or ""))
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
        # A source's explicit zone is respected; otherwise Toronto local wall clock.
        zoned = datetime.combine(day, time(hour, minute), tzinfo=TORONTO)
        if match.group(3) and match.group(3).upper() == "EST" and zoned.utcoffset() != timedelta(hours=-5):
            return datetime.combine(day, time(hour, minute),tzinfo=TORONTO).replace(fold=1), "minute"
        return zoned, "minute"
    # Noon is a serialization placeholder only; never display as a verified send time.
    return datetime.combine(day, time(12), tzinfo=TORONTO), "date"

def detect_stage(summary):
    v=str(summary or "").lower()
    if re.search(r"(?:stage\s*3|مرحله\s*[۳3]|فالوآپ\s*مرحله\s*[۳3])", v): return "stage3"
    if re.search(r"(?:stage\s*2|مرحله\s*[۲2]|فالوآپ\s*مرحله\s*[۲2])", v): return "stage2"
    if re.search(r"(?:پروپوزال|proposal|package|پکیج)", v): return "proposal"
    if re.search(r"(?:letter|نامه)", v): return "letter"
    return "other"

def detect_status(status):
    v = str(status or "").lower()
    if re.search(r"(?:replied|پاسخ (?:رسید|داده شد)|جواب (?:رسید|داد))",v): return "replied"
    if re.search(r"(?:bounced|bounce received|برگشت خورد|برگشتی دریافت شد)",v): return "bounced"
    # "no bounce, considered delivered" is not independently verified provider delivery.
    if re.search(r"(?:confirmed delivered|delivered by provider|تحویل قطعی|delivery confirmed)",v): return "delivered"
    return "sent"

def read_eml(eml_file):
    msg=BytesParser(policy=policy.default).parsebytes(eml_file.read_bytes())
    if msg.is_multipart():
        part=next((p for p in msg.walk() if p.get_content_type()=="text/plain" and p.get_content_disposition()!="attachment"),None)
    else: part=msg if msg.get_content_type()=="text/plain" else None
    body=part.get_content() if part else ""
    return {
        "body_text": body if isinstance(body,str) else "",
        "subject": str(msg.get("Subject","")),
        "from": str(msg.get("From","")),
        "recipients": [a.lower() for _,a in getaddresses(msg.get_all("To",[]))],
        "message_id": str(msg.get("Message-ID","")).strip(),
        "attachment": next((str(p.get_filename()) for p in msg.walk() if p.get_filename() and p.get_filename().lower().endswith(".pdf")), "")
    }

def stable_id(day,biz,stage,to_email,message_id,source_summary):
    # Distinct sends on the same day must remain distinct unless id/message_id or
    # the original register row contents prove they are the same entry.
    key="|".join([str(day),normal(biz),stage,to_email.lower(),str(message_id or ""),str(source_summary or "")])
    return "snd-"+str(day)+"-"+slug(biz)+"-"+hashlib.sha256(key.encode()).hexdigest()[:12]

def read_csv(fp):
    with fp.open("r",encoding="utf-8-sig",newline="") as f:
        reader=csv.DictReader(f)
        if not reader.fieldnames or not set(COLS).issubset(set(reader.fieldnames)):
            raise ValueError("CSV must contain original Jarvis correspondence columns: "+", ".join(COLS))
        for line,row in enumerate(reader,2): yield line,row

def read_xlsx(fp):
    """Read the exact Jarvis tab from an actual XLSX export, without editing the workbook."""
    try:
        from openpyxl import load_workbook
    except ImportError as exc:
        raise RuntimeError("Install openpyxl to import a genuine XLSX export") from exc
    workbook=load_workbook(fp, read_only=True, data_only=True)
    try:
        tab=workbook["مکاتبات"]
        tab.reset_dimensions()
        values=tab.iter_rows(values_only=True)
        header=next(values,None)
        if header is None or not set(COLS).issubset(set(str(x) for x in header if x is not None)):
            raise ValueError("Jarvis XLSX tab 'مکاتبات' has missing or changed columns")
        indexes={str(v):i for i,v in enumerate(header) if v is not None}
        for row_num,cells in enumerate(values,2):
            record={col:str(cells[indexes[col]] if indexes[col] < len(cells) and cells[indexes[col]] is not None else "") for col in COLS}
            if any(record.values()):
                yield row_num,record
    finally:
        workbook.close()

def read_mirror(fp):
    # Markdown is only a second source when there is a proper table with same Jarvis headers.
    text=fp.read_text(encoding="utf-8")
    for line_no,line in enumerate(text.splitlines(),1):
        if not line.startswith("|"): continue
        cells=[s.strip() for s in line.strip().strip("|").split("|")]
        if len(cells)<7 or not parse_date(cells[0]):continue
        yield line_no,dict(zip(COLS,cells))

def build(row,cards,eml_dir,eml_index):
    if str(row.get("جهت","")).strip() not in ("ارسال","sent","outbound","خروجی"):return None,"not_outbound"
    day=parse_date(row.get("تاریخ"))
    if not day:return None,"bad_date"
    biz=str(row.get("طرف مکاتبه","")).strip()
    if not biz:return None,"missing_business"
    original_biz=biz
    if biz.startswith("نامهٔ همکاری ارجاعی —"):
        biz=biz.split("—",1)[1].strip()
    if biz.startswith("کمپین AVA") or " / " in biz:
        return None,"aggregate_or_unconfirmed"
    verification=str(row.get("وضعیت","")).strip()
    # Attempted, failed or pending DM is not a confirmed send. Keep in the
    # private source register for investigation; never show it as SENT.
    if ("تایم" in verification and "بچ متوقف" in verification) or re.search(
        r"(?:^\s*ننشست\b|^\s*نتیجه\s+نامشخص|^\s*در\s+انتظار\s+تأیید|هیچ\s+رشته‌ای\s+ساخته\s+نشده)",
        verification
    ):
        return None,"aggregate_or_unconfirmed"
    summary=str(row.get("خلاصه","")).strip();channel=str(row.get("کانال / لینک","")).strip()
    note=str(row.get("وضعیت","")).strip()
    recipient=EMAIL.findall(channel)
    to_email=recipient[-1] if recipient else ""
    from_email=recipient[0] if len(recipient)>1 and recipient[0].lower()!=to_email.lower() else ""
    stage=detect_stage(summary)
    message=MSGID.search(summary+" "+note)
    message_id=message.group(1) if message else ""
    phone_card=cards.get(normal(biz),{})
    stamp,precision=parse_time(day,note)
    attachment=(PDFNAME.search(summary) or PDFNAME.search(channel))
    filename=(EMLNAME.search(summary) or EMLNAME.search(channel))
    full={}
    if filename and eml_dir:
        match=eml_index.get(filename.group(0).lower())
        if match:
            full=read_eml(match)
            # Prevent assigning one company's full text to a different recipient.
            if to_email and full["recipients"] and to_email.lower() not in full["recipients"]:
                full={}
    if full and not message_id: message_id=full["message_id"]
    if full and not to_email and full["recipients"]:to_email=full["recipients"][0]
    is_email=bool(to_email) or ("ایمیل" in channel) or ("email" in channel.lower())
    result={
        "id":stable_id(day,biz,stage,to_email,message_id,summary),
        "business_slug":phone_card.get("slug") or slug(biz),
        "business_name":biz,
        "stage":stage, "sent_at":stamp.isoformat(timespec="seconds"),
        "time_precision":precision,
        "channel":"email" if is_email else ("dm" if ("دایرکت" in channel or "instagram" in channel.lower()) else ("form" if "فرم" in channel else "other")),
        "from":full.get("from","") or from_email, "to_email":to_email,
        "phone":phone_card.get("phone",""),
        "subject":full.get("subject",""),
        "body_text":full.get("body_text",""),
        "attachment":full.get("attachment","") or (attachment.group(0) if attachment else ""),
        "status":detect_status(note),
        "message_id":message_id,
        "reply_note":note if detect_status(note)=="replied" else None,
        "status_note":note or None,
        "source_summary":summary,
    }
    return result,"ok" if phone_card else "unmatched_card"

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    source=ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--csv",type=Path,help="Actual Jarvis correspondence tab exported as CSV")
    source.add_argument("--xlsx",type=Path,help="Original Jarvis Hub workbook with مکاتبات tab")
    ap.add_argument("--mirror",type=Path,help="Optional original correspondence-log.md")
    ap.add_argument("--eml-dir",type=Path,help="Optional genuine raw Sent .eml files for exact body")
    ap.add_argument("--out",type=Path,required=True,help="Protected data path outside public repo")
    ap.add_argument("--include-other-projects",action="store_true",help="Explicit admin approval to expose unrelated projects to Partners")
    ap.add_argument("--index",type=Path,default=REPO/"index.html")
    ap.add_argument("--report",type=Path,help="Path for private import summary")
    args=ap.parse_args()
    out=args.out.resolve()
    if out.is_relative_to(REPO) and not out.is_relative_to(REPO/"private"):
        raise SystemExit("Refusing to write correspondence into public repository files")
    cards=cards_from_html(args.index)
    emls={}
    if args.eml_dir:
        if not args.eml_dir.is_dir():raise SystemExit("EML dir not found")
        emls={p.name.lower():p for p in args.eml_dir.rglob("*.eml") if p.is_file()}
    sources=list(read_xlsx(args.xlsx) if args.xlsx else read_csv(args.csv))
    if args.mirror: sources+=list(read_mirror(args.mirror))
    seen_ids=set();seen_mids=set();seen_semantic=set()
    existing=[]
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            if not line.strip():continue
            val=json.loads(line);existing.append(val)
            seen_ids.add(val.get("id"))
            if val.get("message_id"):seen_mids.add(val["message_id"])
            seen_semantic.add((str(val.get("sent_at",""))[:10],normal(val.get("business_name")),val.get("stage"),val.get("to_email","").lower(),str(val.get("source_summary",""))))
    stats={"source_rows":len(sources),"existing":len(existing),"added":0,"duplicate":0,"skipped":0,"excluded_other_projects":0,"quarantined_unconfirmed":0,"unmatched_cards":[],"full_bodies_added":0}
    pending=[]
    for _,row in sources:
        group=normal(row.get("بخش",""))
        if not args.include_other_projects and ("zhiostudio" in group or "tibox" in group):
            stats["excluded_other_projects"]+=1
            continue
        rec,kind=build(row,cards,args.eml_dir,emls)
        if not rec:
            stats["quarantined_unconfirmed" if kind=="aggregate_or_unconfirmed" else "skipped"]+=1
            continue
        semantic=(rec["sent_at"][:10],normal(rec["business_name"]),rec["stage"],rec["to_email"].lower(),str(rec.get("source_summary","")))
        if rec["id"] in seen_ids or (rec["message_id"] and rec["message_id"] in seen_mids) or semantic in seen_semantic:
            stats["duplicate"]+=1;continue
        seen_ids.add(rec["id"]);seen_semantic.add(semantic)
        if rec["message_id"]:seen_mids.add(rec["message_id"])
        if kind=="unmatched_card":stats["unmatched_cards"].append(rec["business_name"])
        stats["full_bodies_added"]+=bool(rec["body_text"])
        pending.append(rec);stats["added"]+=1
    out.parent.mkdir(parents=True,exist_ok=True)
    if pending:
        with out.open("a",encoding="utf-8") as f:
            for r in pending:f.write(json.dumps(r,ensure_ascii=False,separators=(",",":"))+"\n")
    stats["unmatched_cards"]=sorted(set(stats["unmatched_cards"]))
    public_stats={**stats,"unmatched_cards_count":len(stats["unmatched_cards"])}
    print(json.dumps(public_stats,ensure_ascii=False,indent=2))
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding="utf-8")

if __name__=="__main__":main()
