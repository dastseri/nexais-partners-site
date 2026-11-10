"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),http=require("node:http");
const ROOT=path.join(__dirname,"..");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"nexais-partners-"));
const users=path.join(dir,"users.json");
const sendsFile=path.join(dir,"sends.jsonl");
process.env.PARTNERS_USERS_FILE=users;
process.env.PARTNERS_SENDS_PATH=sendsFile;
process.env.PARTNERS_SEND_STATUS_PATH=path.join(dir,"send-status-events.jsonl");
process.env.PARTNERS_SESSION_SECRET="test-secret-ONLY-test-secret-ONLY-test-secret-ONLY-";
const salt=crypto.randomBytes(16);
fs.writeFileSync(users,JSON.stringify([{username:"local-test-admin",role:"admin",active:true,password_salt:salt.toString("hex"),password_hash:crypto.scryptSync("correct-password",salt,64).toString("hex")}]));
const hub=require("../server.js");
const appJs=fs.readFileSync(path.join(ROOT,"app/sends.js"),"utf8");
const html=fs.readFileSync(path.join(ROOT,"index.html"),"utf8");

async function withServer(action){
 const instance=http.createServer((req,res)=>hub.handler(req,res));
 await new Promise(resolve=>instance.listen(0,"127.0.0.1",resolve));
 const base=`http://127.0.0.1:${instance.address().port}`;
 try{return await action(base);}
 finally{await new Promise(resolve=>instance.close(resolve));}
}
test("private ledger absent yields empty results rather than exception",()=>{
 assert.deepEqual(hub.sends(),[]);
});
test("application JavaScript parses and includes bilingual labels",()=>{
 new (require("node:vm").Script)(appJs);
 assert.match(appJs,/ارسال‌شده به این کسب‌وکار/);
 assert.match(appJs,/Full text not archived for this send/);
 assert.match(appJs,/America\/Toronto/);
 assert.match(appJs,/navigator\.clipboard/);
});
test("hub has secure sends integration and unchanged manual sheet sync payload",()=>{
 assert.match(html,/<script src="\/app\/sends\.js" defer><\/script>/);
 assert.match(html,/entries: batch/);
 assert.match(html,/NEXAIS_hubAuthenticated = true/);
 assert.doesNotMatch(html,/var KEY = "nexais-partners"/);
});
test("anonymous users cannot see hub, artwork or correspondence",async()=>{
 await withServer(async base=>{
  const app=await fetch(base+"/app",{redirect:"manual"});
  assert.equal(app.status,302);assert.equal(app.headers.get("location"),"/login");
  assert.equal((await fetch(base+"/api/sends")).status,401);
  assert.equal((await fetch(base+"/app/sends.js")).status,401);
  assert.equal((await fetch(base+"/assets/ava.jpg")).status,401);
 });
});
test("login rejects requests without same-origin Origin header",async()=>{
 await withServer(async base=>{
  const r=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"local-test-admin",password:"correct-password"})});
  assert.equal(r.status,403);
 });
});
test("admin-only provisioned account can login and securely load empty real ledger",async()=>{
 await withServer(async base=>{
  const r=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json","Origin":base},body:JSON.stringify({username:"local-test-admin",password:"correct-password"})});
  assert.equal(r.status,200);
  const cookie=r.headers.get("set-cookie").split(";")[0];
  const response=await fetch(base+"/api/sends",{headers:{Cookie:cookie}});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).sends,[]);
  const app=await fetch(base+"/app",{headers:{Cookie:cookie}});
  assert.equal(app.status,200);
  assert.match(await app.text(),/NexAIS Sales Partners/);
 });
});
test("invalid password is rejected",async()=>{
 await withServer(async base=>{
  const r=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json","Origin":base},body:JSON.stringify({username:"local-test-admin",password:"wrong"})});
  assert.equal(r.status,401);
 });
});
test("no public files or directory traversal through private endpoint",async()=>{
 await withServer(async base=>{
  assert.equal((await fetch(base+"/private/sends.jsonl")).status,404);
  assert.equal((await fetch(base+"/.gitignore")).status,404);
  assert.equal((await fetch(base+"/server.js")).status,404);
 });
});

test("append-only delivery event changes current status without modifying the original send",()=>{
 const original={
  id:"test-send-1",business_slug:"test-company",business_name:"Test Company",
  stage:"proposal",sent_at:"2026-11-09T11:45:00-05:00",channel:"email",
  from:"test@example.invalid",to_email:"recipient@example.invalid",phone:"",
  subject:"Sent subject",body_text:"First line\nSecond line",attachment:"",
  status:"sent",message_id:"test-provider-message-1",reply_note:null
 };
 fs.writeFileSync(sendsFile,JSON.stringify(original)+"\n");
 const event={send_id:"test-send-1",event_id:"test-status-1",at:"2026-11-09T12:00:00-05:00",status:"replied",reply_note:"Requested callback",replied_at:"2026-11-09T12:00:00-05:00"};
 fs.writeFileSync(process.env.PARTNERS_SEND_STATUS_PATH,JSON.stringify(event)+"\n");
 const result=hub.sends();
 assert.equal(result.length,1);
 assert.equal(result[0].status,"replied");
 assert.equal(result[0].reply_note,"Requested callback");
 assert.equal(result[0].body_text,original.body_text);
 assert.equal(JSON.parse(fs.readFileSync(sendsFile,"utf8")).status,"sent");
 fs.unlinkSync(sendsFile);fs.unlinkSync(process.env.PARTNERS_SEND_STATUS_PATH);
});
test("server rejects duplicate id and provider message ID in private JSONL",()=>{
 const records=[
  {id:"s1",message_id:"m1",stage:"proposal",status:"sent",sent_at:"2026-11-09T11:40:00-05:00",business_name:"One"},
  {id:"s1",message_id:"m2",stage:"proposal",status:"sent",sent_at:"2026-11-09T11:41:00-05:00",business_name:"One"},
  {id:"s3",message_id:"m1",stage:"letter",status:"sent",sent_at:"2026-11-09T11:42:00-05:00",business_name:"One"},
  {id:"s4",message_id:"m4",stage:"stage2",status:"sent",sent_at:"2026-11-09T11:43:00-05:00",business_name:"Two"}
 ];
 fs.writeFileSync(sendsFile,records.map(x=>JSON.stringify(x)).join("\n")+"\n");
 const result=hub.sends();
 assert.deepEqual(result.map(x=>x.id),["s4","s1"]);
 fs.unlinkSync(sendsFile);
});
test("verified short business names render without fuzzy matching or guessed phones",()=>{
 assert.match(appJs,/KNOWN_ALIASES/);
 assert.match(appJs,/ascottparceventcentre/);
 assert.match(appJs,/bayviewgolfandcountryclub/);
 assert.match(appJs,/No phone on file/);
 assert.doesNotMatch(appJs,/Muse/);
});

test("private API omits internal Jarvis operational notes while preserving exact sent content",async()=>{
 const original={
  id:"test-secure-1",business_slug:"test-company",business_name:"Test Company",
  stage:"proposal",sent_at:"2026-11-09T11:45:00-05:00",channel:"email",
  from:"sender@example.invalid",to_email:"recipient@example.invalid",phone:"",
  subject:"Original",body_text:"Original full email\\nSecond line",attachment:"",
  status:"bounced",message_id:"test-private-1",reply_note:null,
  source_summary:"INTERNAL JARVIS SECRET NOTE",status_note:"INTERNAL OWNER INSTRUCTIONS",
  internal_debug_token:"NEVER_EXPOSE"
 };
 fs.writeFileSync(sendsFile,JSON.stringify(original)+"\n");
 try {
  const items=hub.sends();
  assert.equal(items.length,1);
  assert.equal(items[0].body_text,original.body_text);
  assert.equal(items[0].subject,"Original");
  assert.equal(items[0].source_summary,undefined);
  assert.equal(items[0].status_note,undefined);
  assert.equal(items[0].internal_debug_token,undefined);
  await withServer(async base=>{
   const login=await fetch(base+"/api/login",{method:"POST",
     headers:{"Content-Type":"application/json","Origin":base},
     body:JSON.stringify({username:"local-test-admin",password:"correct-password"})});
   assert.equal(login.status,200);
   const cookie=login.headers.get("set-cookie").split(";")[0];
   const read=await fetch(base+"/api/sends",{headers:{Cookie:cookie}});
   assert.equal(read.status,200);
   const json=await read.text();
   assert.doesNotMatch(json,/INTERNAL JARVIS SECRET NOTE|INTERNAL OWNER INSTRUCTIONS|NEVER_EXPOSE/);
   assert.match(json,/Original full email/);
  });
 }finally {fs.unlinkSync(sendsFile);}
});

test("partners can only read owner-assigned businesses while admin sees the complete ledger",async()=>{
 const userRecords=JSON.parse(fs.readFileSync(users,"utf8"));
 const assignedSalt=crypto.randomBytes(16);
 const unassignedSalt=crypto.randomBytes(16);
 userRecords.push({username:"scoped-partner",role:"partner",active:true,business_slugs:["company-one"],
   password_salt:assignedSalt.toString("hex"),password_hash:crypto.scryptSync("partner-password",assignedSalt,64).toString("hex")});
 userRecords.push({username:"unassigned-partner",role:"partner",active:true,business_slugs:[],
   password_salt:unassignedSalt.toString("hex"),password_hash:crypto.scryptSync("unassigned-password",unassignedSalt,64).toString("hex")});
 fs.writeFileSync(users,JSON.stringify(userRecords));
 const history=[
  {id:"privacy-1",business_slug:"company-one",business_name:"Company One",stage:"proposal",status:"sent",sent_at:"2026-11-09T11:00:00-05:00",to_email:"one@example.invalid",body_text:"ONE CONFIDENTIAL CONTENT"},
  {id:"privacy-2",business_slug:"company-two",business_name:"Company Two",stage:"proposal",status:"sent",sent_at:"2026-11-09T12:00:00-05:00",to_email:"two@example.invalid",body_text:"TWO CONFIDENTIAL CONTENT"}
 ];
 fs.writeFileSync(sendsFile,history.map(r=>JSON.stringify(r)).join("\n")+"\n");
 try {
  await withServer(async base=>{
   async function login(username,password){
    const r=await fetch(base+"/api/login",{method:"POST",headers:{"Content-Type":"application/json","Origin":base},body:JSON.stringify({username,password})});
    assert.equal(r.status,200);return r.headers.get("set-cookie").split(";")[0];
   }
   const partnerCookie=await login("scoped-partner","partner-password");
   const scoped=await fetch(base+"/api/sends",{headers:{Cookie:partnerCookie}});
   assert.equal(scoped.status,200);
   const partnerResult=await scoped.json();
   assert.deepEqual(partnerResult.sends.map(x=>x.id),["privacy-1"]);
   assert.doesNotMatch(JSON.stringify(partnerResult),/TWO CONFIDENTIAL CONTENT|two@example.invalid/);
   const unassignedCookie=await login("unassigned-partner","unassigned-password");
   const unassigned=await fetch(base+"/api/sends",{headers:{Cookie:unassignedCookie}});
   assert.deepEqual((await unassigned.json()).sends,[]);
   const adminCookie=await login("local-test-admin","correct-password");
   const admin=await fetch(base+"/api/sends",{headers:{Cookie:adminCookie}});
   assert.equal((await admin.json()).sends.length,2);
   userRecords[1].business_slugs=[];
   fs.writeFileSync(users,JSON.stringify(userRecords));
   const revoked=await fetch(base+"/api/sends",{headers:{Cookie:partnerCookie}});
   assert.deepEqual((await revoked.json()).sends,[]);
  });
 }finally{fs.unlinkSync(sendsFile);fs.writeFileSync(users,JSON.stringify(userRecords.slice(0,1)));}
});

test("partner HTML response excludes unassigned legacy cards and research queue",async()=>{
 const originalUsers=fs.readFileSync(users,"utf8");
 const salt2=crypto.randomBytes(16);
 const scoped={username:"legacy-scoped",role:"partner",active:true,business_slugs:["copper-creek-golf-club"],
   password_salt:salt2.toString("hex"),password_hash:crypto.scryptSync("scoped-password",salt2,64).toString("hex")};
 fs.writeFileSync(users,JSON.stringify([...JSON.parse(originalUsers),scoped]));
 try{
  await withServer(async base=>{
   const login=await fetch(base+"/api/login",{method:"POST",headers:{"Origin":base,"Content-Type":"application/json"},
    body:JSON.stringify({username:"legacy-scoped",password:"scoped-password"})});
   assert.equal(login.status,200);
   const cookie=login.headers.get("set-cookie").split(";")[0];
   const app=await fetch(base+"/app",{headers:{Cookie:cookie}});
   assert.equal(app.status,200);
   const htmlText=await app.text();
   assert.match(htmlText,/data-name="copper creek golf club"/);
   assert.doesNotMatch(htmlText,/data-name="richmond hill golf club"/);
   assert.doesNotMatch(htmlText,/3rdparty@dayandrossinc\.ca/);
   assert.doesNotMatch(htmlText,/ross\.tyrell@sunbeltrentals\.com/);
  });
 }finally{fs.writeFileSync(users,originalUsers);}
});

test("authenticated partner identity scopes local call-log and Sheet queue without changing payload",async()=>{
 assert.match(html,/NEXAIS_userRole === "partner"/);
 assert.match(html,/nexais-hub-sheet-queue-v1" \+ scope/);
 assert.match(html,/nexais-hub-activity-v1" \+ scope/);
 assert.match(html,/entries: batch/);
 const source=JSON.parse(fs.readFileSync(users,"utf8"));
 const saltX=crypto.randomBytes(16);
 source.push({username:"partition-partner",role:"partner",active:true,business_slugs:[],
  password_salt:saltX.toString("hex"),password_hash:crypto.scryptSync("correct-password",saltX,64).toString("hex")});
 const original=fs.readFileSync(users,"utf8");
 fs.writeFileSync(users,JSON.stringify(source));
 try {
  await withServer(async base=>{
   const response=await fetch(base+"/api/login",{method:"POST",
    headers:{"Content-Type":"application/json","Origin":base},
    body:JSON.stringify({username:"partition-partner",password:"correct-password"})});
   assert.equal(response.status,200);
   const cookie=response.headers.get("set-cookie").split(";")[0];
   const page=await fetch(base+"/app",{headers:{Cookie:cookie}});
   assert.equal(page.status,200);
   const out=await page.text();
   assert.match(out,/window\.NEXAIS_userId="partition-partner"/);
   assert.match(out,/window\.NEXAIS_userRole="partner"/);
   assert.doesNotMatch(out,/window\.NEXAIS_userRole="admin"/);
  });
 }finally {fs.writeFileSync(users,original);}
});
