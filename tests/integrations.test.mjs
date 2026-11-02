import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac,generateKeyPairSync,createVerify } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { openDatabase,activePlan } from '../src/db.mjs';
import { processStripeEvent } from '../src/stripe.mjs';
import { githubAppJwt,postReview } from '../src/github.mjs';
import { reviewWithAI } from '../src/reviewer.mjs';

function signedEvent(event,secret='whsec_integrations'){
  const raw=JSON.stringify(event),time=Math.floor(Date.now()/1000);
  const hash=createHmac('sha256',secret).update(`${time}.${raw}`).digest('hex');
  return {raw,signature:`t=${time},v1=${hash}`};
}
test('Signed Stripe events activate and cancel entitlements; duplicate deliveries ignored',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reviewforge-billing-')),before=config.stripe.webhookSecret;
  try{
    const db=openDatabase(join(dir,'test.sqlite'));
    db.prepare('INSERT INTO users(id,login,name) VALUES (123,?,?)').run('customer','Customer');
    config.stripe.webhookSecret='whsec_integrations';
    const event=(id,type,status)=>({id,type,data:{object:{id:'sub_abc',customer:'cus_abc',status,metadata:{reviewforge_user_id:'123'}}}});
    const a=signedEvent(event('evt_new','customer.subscription.created','active'));
    assert.equal(await processStripeEvent(db,a.raw,a.signature), 'customer.subscription.created');
    assert.equal(await activePlan(db,123),'pro');
    assert.equal(await processStripeEvent(db,a.raw,a.signature),'duplicate');
    const b=signedEvent(event('evt_del','customer.subscription.deleted','canceled'));
    await processStripeEvent(db,b.raw,b.signature);assert.equal(await activePlan(db,123),'free');db.close();
  }finally{config.stripe.webhookSecret=before;rmSync(dir,{recursive:true,force:true});}
});
test('GitHub App JWT signs with generated RSA private key',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const oldId=config.github.appId,oldKey=config.github.privateKey;
  try{
    config.github.appId='123456';config.github.privateKey=privateKey.export({format:'pem',type:'pkcs8'});
    const jwt=githubAppJwt(),parts=jwt.split('.');assert.equal(parts.length,3);
    const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString());assert.equal(payload.iss,'123456');
    const verifier=createVerify('RSA-SHA256');verifier.update(parts[0]+'.'+parts[1]);verifier.end();
    assert.ok(verifier.verify(publicKey,Buffer.from(parts[2],'base64url')));
  }finally{config.github.appId=oldId;config.github.privateKey=oldKey;}
});
test('OpenAI structured result is validated before findings are accepted',async()=>{
  const oldKey=config.openai.apiKey,oldFetch=globalThis.fetch;
  const files=[{filename:'lib/auth.ts',patch:'@@ -1,2 +1,3 @@\n context\n+console.log(secret)\n end'}];
  let called=false;
  try{
    config.openai.apiKey='test-only';
    globalThis.fetch=async(url,request)=>{
      called=true;assert.match(url,/\/responses$/);
      const body=JSON.parse(request.body);
      assert.equal(body.store,false);assert.equal(body.text.format.type,'json_schema');
      return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:JSON.stringify({summary:'One concrete issue',findings:[
        {path:'lib/auth.ts',line:2,severity:'high',category:'security',title:'Secret in log',body:'Credentials may be logged if this executes.',confidence:.91},
        {path:'lib/auth.ts',line:99,severity:'critical',category:'security',title:'Fake finding',body:'Should not survive grounding.',confidence:.99}
      ]})}]}]})};
    };
    const result=await reviewWithAI(files);assert.ok(called);assert.equal(result.findings.length,1);
    assert.equal(result.findings[0].line,2);
    assert.deepEqual(result.diagnostics,{modelSuggestions:2,acceptedFindings:1,filteredFindings:1});
  }finally{config.openai.apiKey=oldKey;globalThis.fetch=oldFetch;}
});
test('GitHub reviews send added-line inline comments with commit SHA',async()=>{
  const old=globalThis.fetch;let body;
  try{
    globalThis.fetch=async(url,request)=>{
      assert.match(url,/pulls\/7\/reviews/);
      assert.equal(request.method,'POST');body=JSON.parse(request.body);
      return {ok:true,text:async()=>JSON.stringify({id:101})};
    };
    const posted=await postReview({repoFullName:'example/repo',prNumber:7,headSha:'abcdef',token:'fake-token',summary:'A real issue',findings:[
      {path:'lib/test.js',line:8,severity:'high',title:'Bug',body:'This can fail',confidence:0.95}
    ]});
    assert.equal(posted,'inline');assert.equal(body.commit_id,'abcdef');
    assert.deepEqual(body.comments[0].path,'lib/test.js');assert.equal(body.comments[0].line,8);
  }finally{globalThis.fetch=old;}
});
