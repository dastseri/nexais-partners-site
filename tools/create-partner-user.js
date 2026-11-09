#!/usr/bin/env node
/* Admin-only offline account provisioning. No public sign-up or CRM.
 * PARTNERS_NEW_PASSWORD env or stdin: echo 'password' | node tools/create-partner-user.js --user name --role partner --file /secure/partners-users.json
 */
"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const args=process.argv.slice(2);
const arg=(k)=>{const i=args.indexOf(k);return i<0?null:args[i+1]};
const username=arg("--user"),role=arg("--role")||"partner",file=arg("--file");
if(!username||!/^[a-zA-Z0-9._-]{3,64}$/.test(username)||!["admin","partner"].includes(role)||!file){
 console.error("Usage: node tools/create-partner-user.js --user NAME --role admin|partner --file PRIVATE_JSON_FILE");
 process.exit(2);
}
function write(pass){
 if(pass.length<12){console.error("Password must have at least 12 characters");process.exit(2);}
 let users=[];if(fs.existsSync(file))users=JSON.parse(fs.readFileSync(file,"utf8"));
 if(!Array.isArray(users))throw Error("User database must be an array");
 const salt=crypto.randomBytes(32);
 const record={username,role,active:true,password_salt:salt.toString("hex"),password_hash:crypto.scryptSync(pass,salt,64).toString("hex")};
 const existing=users.findIndex(x=>x.username===username);
 if(existing>=0)users[existing]=record;else users.push(record);
 fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true,mode:0o700});
 fs.writeFileSync(file,JSON.stringify(users,null,2)+"\n",{mode:0o600});
 fs.chmodSync(file,0o600);
 console.log("Account provisioned:",username,role,"(password not displayed)");
}
if(process.env.PARTNERS_NEW_PASSWORD)write(process.env.PARTNERS_NEW_PASSWORD);
else {let data="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>data+=x);process.stdin.on("end",()=>write(data.replace(/\r?\n$/,"")));if(process.stdin.isTTY)console.error("Enter password using stdin or PARTNERS_NEW_PASSWORD; no password flag is accepted.");}
