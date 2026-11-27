import test from 'node:test';
import assert from 'node:assert/strict';
import {isCodeRabbitQuotaEvent,currentHeadReviewRequest,alreadyReviewedExactHead,matchesCurrentQuotaNotice} from '../src/coderabbit-fallback.mjs';
const sha='a'.repeat(40);
const requestAt='2026-10-30T09:00:00Z',noticeAt='2026-10-30T09:01:00Z';
const request={user:{login:'github-actions[bot]'},created_at:requestAt,
 body:'<!-- proffera-coderabbit-final-review-request:'+sha+' -->\n@coderabbitai review'};
const bot={user:{login:'coderabbitai[bot]'},created_at:noticeAt,body:'Review rate limited. Your included review limit is currently reached.'};
const event={action:'created',issue:{number:941,pull_request:{}},
 repository:{full_name:'ibboabdoli-ai/Proffera'},installation:{id:123},comment:bot};
test('only authenticated CodeRabbit bot quota notices trigger fallback',()=>{
 assert.ok(isCodeRabbitQuotaEvent(event));
 for(const action of ['created','edited'])assert.ok(isCodeRabbitQuotaEvent({...event,action}));
 assert.ok(!isCodeRabbitQuotaEvent({...event,comment:{...bot,user:{login:'attacker'}}}));
 assert.ok(!isCodeRabbitQuotaEvent({...event,comment:{...bot,body:'Review finished'}}));
 assert.ok(!isCodeRabbitQuotaEvent({...event,issue:{number:941}}));
});
test('requires trusted exact-HEAD request AND bot-bound quota evidence',()=>{
 const correlatedBot={...bot,body:'<!-- CodeRabbit quota exact-head: '+sha+' -->\n'+bot.body};
 const delayedOldSha={...bot,body:'<!-- CodeRabbit quota exact-head: '+'b'.repeat(40)+' -->\n'+bot.body};
 // Current genuine CodeRabbit quota text lacks this marker: do not queue a paid review.
 assert.equal(currentHeadReviewRequest([request],sha,bot),null);
 // Authentic but delayed old-SHA reply after a current request must also fail.
 assert.equal(currentHeadReviewRequest([request],sha,delayedOldSha),null);
 // Synthetic future format only: this is not proof that CodeRabbit emits the marker.
 assert.equal(currentHeadReviewRequest([request],sha,correlatedBot),request);
 assert.equal(currentHeadReviewRequest([request],'b'.repeat(40),correlatedBot),null);
 assert.equal(currentHeadReviewRequest([{...request,user:{login:'attacker'}}],sha,correlatedBot),null);
 assert.equal(currentHeadReviewRequest([{...request,created_at:'2026-10-30T09:02:00Z'}],sha,correlatedBot),null);
 assert.equal(currentHeadReviewRequest([request],sha,{...correlatedBot,created_at:'2026-10-30T11:00:00Z'}),null);
});

test('current-head CodeRabbit review or inline findings block fallback',()=>{
 assert.equal(alreadyReviewedExactHead([],[],sha,requestAt),false);
 assert.equal(alreadyReviewedExactHead([{user:{login:'coderabbitai[bot]'},commit_id:sha,state:'COMMENTED',submitted_at:noticeAt}],[],sha,requestAt),true);
 assert.equal(alreadyReviewedExactHead([],[{user:{login:'coderabbitai[bot]'},original_commit_id:sha,created_at:noticeAt}],sha,requestAt),true);
 assert.equal(alreadyReviewedExactHead([{user:{login:'coderabbitai[bot]'},commit_id:'b'.repeat(40),state:'COMMENTED',submitted_at:noticeAt}],[],sha,requestAt),false);
 assert.equal(alreadyReviewedExactHead(null,[],sha,requestAt),true);
});

test('fallback-only webhook path is present and protected by exact allowlists',async()=>{
 const {readFileSync}=await import('node:fs');
 const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(server,/event==='issue_comment' && isCodeRabbitQuotaEvent\(payload\)/);
 assert.match(server,/repositoryAllowed\(payload\.repository\?\.full_name,config\.aiFallbackOnlyRepositories\)/);
 assert.match(server,/matchesCurrentQuotaNotice\(comments,payload\.comment\)/);
 assert.match(server,/currentHeadReviewRequest\(comments,head,payload\.comment\)/);
 assert.match(server,/alreadyReviewedExactHead\(reviews,inline,head,request\.created_at\)/);
 assert.match(server,/automaticShadowReviewDecision\(/);
 assert.match(server,/fallbackOnly:config\.aiFallbackOnlyRepositories/);
 assert.match(server,/db\.reserveReview\(\{installationId:inst\.id,repositoryId:repo\.id,prNumber:prNo,/);
});

test('stale or ambiguous quota deliveries cannot reserve a review',()=>{
 const notice={...bot,id:22,updated_at:noticeAt,body:'<!-- CodeRabbit quota exact-head: '+sha+' -->\n'+bot.body};
 const admission=(comments,delivered=notice)=>matchesCurrentQuotaNotice(comments,delivered)
   ?currentHeadReviewRequest(comments,sha,delivered):null;
 assert.equal(admission([request,notice]),request);
 assert.equal(admission([request]),null);
 assert.equal(admission([request,{...notice,body:'Review finished'}]),null);
 assert.equal(admission([request,{...notice,updated_at:'2026-10-30T09:02:00Z'}]),null);
 assert.equal(admission([request,{...notice,user:{login:'attacker'}}]),null);
 assert.equal(admission([request,notice,notice]),null);
 assert.equal(admission([request,notice],{...notice,id:null}),null);
 assert.equal(admission([notice]),null);
 const unbound={...notice,body:bot.body};
 assert.equal(admission([request,unbound],unbound),null);
});
