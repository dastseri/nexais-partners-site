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
