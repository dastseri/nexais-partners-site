/* Standalone NexAIS Partners Hub: authenticated static app and private read-only send history.
 * No CRM dependency. Accounts are provisioned out of band by the owner/admin.
 * Required env: PARTNERS_SESSION_SECRET, PARTNERS_USERS_JSON or PARTNERS_USERS_FILE,
 * PARTNERS_SENDS_PATH (private JSONL outside publicly served code).
 */
"use strict";
const http=require("node:http"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),url=require("node:url");
const ROOT=path.resolve(__dirname,"..");
const PORT=Number(process.env.PORT||10000);
const SECRET=process.env.PARTNERS_SESSION_SECRET||"";
const USERS_PATH=process.env.PARTNERS_USERS_FILE||"";
const SENDS_PATH=path.resolve(process.env.PARTNERS_SENDS_PATH||path.join(ROOT,"private","sends.jsonl"));
const EVENTS_PATH=path.resolve(process.env.PARTNERS_SEND_STATUS_PATH||path.join(path.dirname(SENDS_PATH),"send-status-events.jsonl"));
const IS_PRODUCTION=process.env.NODE_ENV==="production";
if(require.main===module && (!SECRET || Buffer.byteLength(SECRET)<32)) {console.error("PARTNERS_SESSION_SECRET must be at least 32 bytes");process.exit(1);}
const stageSet=new Set(["proposal","stage2","stage3","letter","other"]),statusSet=new Set(["sent","delivered","bounced","replied"]);
const cookieName="nexais_partner_session";
const MAX_BODY=10*1024;
const attempts=new Map();
const allowedFiles=new Map([["/app/sends.js",path.join(ROOT,"app","sends.js")]]);
function safeEq(a,b) {const x=Buffer.from(String(a||"")),y=Buffer.from(String(b||""));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function parseCookies(req){const result={};for(const piece of (req.headers.cookie||"").split(";")){const i=piece.indexOf("=");if(i>=0)result[piece.slice(0,i).trim()]=piece.slice(i+1).trim();}return result;}
function sign(raw){return crypto.createHmac("sha256",SECRET).update(raw).digest("base64url");}
function makeSession(user){const value=Buffer.from(JSON.stringify({user,exp:Date.now()+8*3600*1000})).toString("base64url");return value+"."+sign(value);}
function userList(){try{const text=USERS_PATH?fs.readFileSync(USERS_PATH,"utf8"):(process.env.PARTNERS_USERS_JSON||"[]");const list=JSON.parse(text);return Array.isArray(list)?list:[];}catch(e){console.error("Could not load user configuration:",e.message);return [];}}
function session(req) {const token=parseCookies(req)[cookieName]||"",idx=token.lastIndexOf(".");if(idx<1)return null;const encoded=token.slice(0,idx),mac=token.slice(idx+1);
 if(!safeEq(sign(encoded),mac))return null;
 try{const data=JSON.parse(Buffer.from(encoded,"base64url").toString());if(!data.user||!Number.isFinite(data.exp)||data.exp<Date.now())return null;const user=userList().find(u=>u.username===data.user&&u.active!==false);return user?{username:user.username,role:user.role||"partner"}:null;}catch{return null;}
}
function headers(extra={}){return Object.assign({"X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Cache-Control":"no-store, private","Content-Security-Policy":"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; object-src 'none'; upgrade-insecure-requests"},extra);}
function reply(res,status,data,ct="application/json; charset=utf-8",extra={}){res.writeHead(status,headers({"Content-Type":ct,...extra}));res.end(ct.startsWith("application/json")?JSON.stringify(data):data);}
function sendFile(res,file,ct){try{const stat=fs.statSync(file);if(!stat.isFile())return reply(res,404,{error:"Not found"});const data=fs.readFileSync(file);reply(res,200,data,ct);}catch{return reply(res,404,{error:"Not found"});}}
function appendStatus(events,r){const result=new Map(r.map(x=>[x.id,{...x}]));for(const item of events){const base=result.get(item.send_id);if(!base||!statusSet.has(item.status))continue;
  base.status=item.status;if(item.status_note!=null)base.status_note=String(item.status_note);
  if(item.reply_note!=null)base.reply_note=String(item.reply_note);
  if(item.replied_at)base.replied_at=item.replied_at;
}return Array.from(result.values());}
function loadJSONL(file){try{return fs.readFileSync(file,"utf8").split(/\r?\n/).filter(Boolean).map((line,i)=>{try{return JSON.parse(line);}catch{console.error("Malformed JSONL line",path.basename(file),i+1);return null;}}).filter(Boolean);}catch(e){if(e.code==="ENOENT")return [];throw e;}}
function sends(){const ids=new Set(),mids=new Set(),items=[];
 for(const r of loadJSONL(SENDS_PATH)){if(!r||typeof r.id!=="string"||!stageSet.has(r.stage)||!statusSet.has(r.status)||typeof r.business_name!=="string"||typeof r.sent_at!=="string")continue;
 if(ids.has(r.id)||(r.message_id&&mids.has(r.message_id)))continue;ids.add(r.id);if(r.message_id)mids.add(r.message_id);items.push(r);}
 return appendStatus(loadJSONL(EVENTS_PATH),items).sort((a,b)=>Date.parse(b.sent_at)-Date.parse(a.sent_at));
}
function isOriginValid(req){const origin=req.headers.origin;const host=req.headers.host;if(!origin||!host)return false;try{return new URL(origin).host===host&&new URL(origin).protocol==="https:"||(!IS_PRODUCTION&&new URL(origin).host===host&&new URL(origin).protocol==="http:");}catch{return false;}}
function parseBody(req){return new Promise((resolve,reject)=>{let data="",length=0;req.on("data",b=>{length+=b.length;if(length>MAX_BODY){reject(new Error("Request too large"));req.destroy();return;}data+=b.toString("utf8");});req.on("end",()=>{try{resolve(JSON.parse(data));}catch{reject(new Error("Invalid JSON"));}});req.on("error",reject);});}
const loginHTML=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexAIS Partners — Sign in</title><style>body{font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;margin:0;background:#f5f8fc;color:#0a1f44}.box{background:white;border:1px solid #dbe4f0;border-radius:14px;padding:30px;max-width:340px;width:90%;box-sizing:border-box}label{display:block;margin:15px 0}input{display:block;width:100%;padding:11px;margin-top:5px;box-sizing:border-box;border-radius:8px;border:1px solid #dbe4f0;font:inherit}button{background:#1f6fe5;color:white;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;font:inherit}#err{color:#ad2525}</style></head><body><div class="box"><h1>NexAIS Partners</h1><p>Owner-provisioned accounts only · فقط حساب‌های ایجادشده توسط مدیر</p><form id="login"><label>Username / نام کاربری<input id="user" autocomplete="username" required></label><label>Password / رمز عبور<input id="pass" type="password" autocomplete="current-password" required></label><button>Sign in / ورود</button><p id="err" role="alert"></p></form></div><script>document.querySelector("#login").addEventListener("submit",async e=>{e.preventDefault();const r=await fetch("/api/login",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:document.querySelector("#user").value,password:document.querySelector("#pass").value})});if(r.ok)location.replace("/app");else document.querySelector("#err").textContent="Invalid credentials / اطلاعات ورود نادرست";});</script></body></html>`;
async function handler(req,res){const pathname=new URL(req.url,"http://localhost").pathname;
 if(pathname==="/healthz")return reply(res,200,{ok:true});
 if(pathname==="/login"&&req.method==="GET")return reply(res,200,loginHTML,"text/html; charset=utf-8");
 if(pathname==="/api/login"&&req.method==="POST"){
  if(!isOriginValid(req))return reply(res,403,{error:"Origin denied"});
  const ip=String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim();
  const record=attempts.get(ip)||{count:0,reset:0};
  if(Date.now()>record.reset){record.count=0;record.reset=Date.now()+15*60*1000;}
  if(record.count>=10)return reply(res,429,{error:"Too many attempts"});
  let body;try{body=await parseBody(req);}catch{return reply(res,400,{error:"Invalid request"});}
  const u=userList().find(x=>x.username===String(body.username||"")&&x.active!==false);
  let valid=false;
  if(u&&u.password_hash&&u.password_salt){
    try{const derived=crypto.scryptSync(String(body.password||""),Buffer.from(u.password_salt,"hex"),64);
     valid=safeEq(derived.toString("hex"),u.password_hash);}catch{}
  }
  if(!valid){record.count++;attempts.set(ip,record);return reply(res,401,{error:"Invalid credentials"});}
  attempts.delete(ip);
  return reply(res,200,{ok:true}, "application/json; charset=utf-8",{"Set-Cookie":`${cookieName}=${makeSession(u.username)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${IS_PRODUCTION?"; Secure":""}`});
 }
 if(pathname==="/api/logout"&&req.method==="POST"){
  if(!isOriginValid(req))return reply(res,403,{error:"Origin denied"});
  return reply(res,200,{ok:true},"application/json; charset=utf-8",{"Set-Cookie":`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${IS_PRODUCTION?"; Secure":""}`});
 }
 if(pathname==="/"||pathname==="/app"){if(!session(req))return reply(res,302,"","text/plain",{"Location":"/login"});return sendFile(res,path.join(ROOT,"index.html"),"text/html; charset=utf-8");}
 if(pathname==="/api/session"){const u=session(req);return u?reply(res,200,{authenticated:true,user:u.username,role:u.role}):reply(res,401,{authenticated:false});}
 if(pathname==="/api/sends"){if(req.method!=="GET")return reply(res,405,{error:"Method not allowed"});if(!session(req))return reply(res,401,{error:"Unauthenticated"});try{return reply(res,200,{sends:sends()});}catch(e){console.error("send read failed",e.message);return reply(res,503,{error:"Send history not available"});}}
 if(allowedFiles.has(pathname)&&req.method==="GET"){if(!session(req))return reply(res,401,{error:"Unauthenticated"});return sendFile(res,allowedFiles.get(pathname),"text/javascript; charset=utf-8");}
 if(pathname.startsWith("/assets/")&&req.method==="GET"){if(!session(req))return reply(res,401,{error:"Unauthenticated"});const asset=pathname.slice("/assets/".length);if(!/^[a-zA-Z0-9_.-]+$/.test(asset))return reply(res,404,{error:"Not found"});const ext=path.extname(asset).toLowerCase();const types={".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".svg":"image/svg+xml",".gif":"image/gif"};if(!types[ext])return reply(res,404,{error:"Not found"});return sendFile(res,path.join(ROOT,"assets",asset),types[ext]);}
 return reply(res,404,{error:"Not found"});
}
if(require.main===module)http.createServer((req,res)=>{Promise.resolve(handler(req,res)).catch(err=>{console.error(err);if(!res.headersSent)reply(res,500,{error:"Internal error"});});}).listen(PORT,()=>console.log("Partners Hub on port",PORT));
module.exports={handler,sends,loadJSONL,appendStatus,makeSession,session,validStatus:statusSet};
