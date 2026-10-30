import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReviewContext, importedPaths, projectRuleExcerpts, safeContextPath, sourceExcerpt } from '../src/review-context.mjs';
import { selectReviewModel } from '../src/model-router.mjs';
import { selectedReviewSkills } from '../src/review-skills.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';
import { config } from '../src/config.mjs';

const sha='a'.repeat(40), repo='sample/review-demo';
const files=[
 {filename:'src/lib/company-directory-detail-validation.ts',status:'modified',
  patch:'@@ -15,6 +17,8 @@\n const errors=collectBolagsverketApiErrors(payload);\n+if (isDeterministicBolagsverketOrganizationNotFound(errors)) {\n+  throw new BolagsverketOrganizationNotFoundError();\n+}'},
 {filename:'src/lib/company-directory-discovery-queue.ts',status:'modified',
  patch:'@@ -520,2 +520,3 @@\n const terminal=attemptCount>=MAX_ATTEMPTS;\n+const delay=deterministicNotFound ? 24*60 : 1;'},
 {filename:'tests/company-directory-discovery-not-found-backoff.test.ts',status:'added',
  patch:'@@ -0,0 +1,2 @@\n+expect(retry.values).toContain(24*60);\n+expect(retry.values).toContain("pending_verify");'}
];
const configFile=[
'reviews:',
'  profile: "assertive"',
'  path_instructions:',
'    - path: "src/**/*.{ts,tsx,js,jsx}"',
'      instructions: |',
'        Check mixed company-record responses and requested identity.',
'        Verify retry and queue failure conditions.',
'    - path: "tests/**/*.{ts,tsx,js,jsx}"',
'      instructions: |',
'        Check that tests fail when the production behavior is broken.',
'chat:',
'  auto_reply: true'].join('\n');
const sourceA=[
'import { isDeterministicBolagsverketOrganizationNotFound, collectBolagsverketApiErrors }',
'from "./company-directory-official-facts-errors";',
'import {rememberComplete} from "./company-directory-detail-cache";',
...Array(8).fill(''),
'export function resolve(payload) {',
'  const errors=collectBolagsverketApiErrors(payload);',
'  if(isDeterministicBolagsverketOrganizationNotFound(errors))throw new Error("NOT_FOUND");',
'  return payload;',
'}'].join('\n');
const sourceB=[
'import { failQueueItem } from "./company-directory-queue-helpers";',
...Array(520).fill(''),
'const terminal=attemptCount>=MAX_ATTEMPTS;',
'const delay=deterministicNotFound ? 24*60 : 1;'].join('\n');
const sources={
 '.coderabbit.yaml':configFile,
 'src/lib/company-directory-detail-validation.ts':sourceA,
 'src/lib/company-directory-discovery-queue.ts':sourceB,
 'src/lib/company-directory-official-facts-errors.ts':'export function collectBolagsverketApiErrors(payload) { return allNestedErrors(payload); }\nexport function isDeterministicBolagsverketOrganizationNotFound(errors) {return errors.every(e=>e.type==="ORGANISATION_FINNS_EJ");}',
 'src/lib/company-directory-detail-cache.ts':'export function rememberComplete(){}',
 'src/lib/company-directory-queue-helpers.ts':'export function failQueueItem(){}'
};
const api=async(path,token)=>{
 assert.equal(token,'fake-token');
 const match=path.match(/^\/repos\/sample\/review-demo\/contents\/(.+)\?ref=([a-f0-9]{40})$/);
 assert.ok(match,'Unexpected GitHub API path '+path);
 assert.equal(match[2],sha);
 const target=decodeURIComponent(match[1]);
 if(!(target in sources))throw new Error('GitHub 404: Not Found');
 const content=sources[target];
 return {type:'file',encoding:'base64',size:Buffer.byteLength(content),
  content:Buffer.from(content).toString('base64')};
};
test('context reading is pinned to SHA, bounded, same-repo and read-only',async()=>{
 const result=await collectReviewContext({repository:repo,sha,files,token:'fake-token',api});
 assert.ok(result.totalChars<=12000);
 assert.ok(result.sourceFiles.includes('src/lib/company-directory-official-facts-errors.ts'));
 assert.match(result.snippets.map(s=>s.text).join('\n'),/isDeterministicBolagsverketOrganizationNotFound/);
 assert.match(result.projectRules,/requested identity/);
 assert.match(result.projectRules,/tests fail when the production/);
 assert.equal(result.headSha,sha);
});
test('private paths, traversal, binary and unrelated repositories are not fetched',async()=>{
 for(const path of ['../../.env','src/.env','src/secrets.ts','src/credentials.ts','node_modules/index.ts','src/../.github/private.ts']){
  assert.equal(safeContextPath(path),false,path);
 }
 assert.deepEqual(importedPaths('src/lib/x.ts','import x from "../../../.env";'),[]);
 await assert.rejects(collectReviewContext({repository:'../evil',sha,files,token:'fake',api}),/Invalid repository/);
});
test('project guidance is only a scoped, untrusted excerpt',()=>{
 const rules=projectRuleExcerpts(configFile,['src/lib/x.ts','tests/x.test.ts']);
 assert.match(rules,/mixed company-record/);
 assert.match(rules,/tests fail/);
 assert.doesNotMatch(rules,/auto_reply/);
 assert.equal(projectRuleExcerpts(configFile,['public/other.html']),'');
});
test('source excerpts include changed hunks with source line labels',()=>{
 const excerpt=sourceExcerpt(sourceB,files[1].patch);
 assert.match(excerpt,/L521:|L522:/);
 assert.ok(excerpt.length<=2700);
});
test('PR953-style queue change selects deep model and specialist review skill',()=>{
 const choice=selectReviewModel(files,{fastModel:'FAST',deepModel:'DEEP'});
 assert.equal(choice.model,'DEEP');
 assert.equal(choice.tier,'deep');
 assert.match(choice.reason,/high-risk/);
 const skills=selectedReviewSkills(files).map(s=>s.id);
 assert.ok(skills.includes('domain-integrity'));
 assert.ok(skills.includes('tests'));
});
test('opted-in incremental flow passes context to model without GitHub posting',async()=>{
 const previousModels=config.aiAutoModelRepositories,previousContext=config.aiContextRepositories;
 config.aiAutoModelRepositories=[repo];
 config.aiContextRepositories=[repo];
 const rows=new Map();let calls=0,posts=0,modelInputs=[];
 const deps={
  installationToken:async()=> 'fake-token',
  githubApi:async()=>({head:{sha},state:'open',draft:false}),
  changedFiles:async()=>files,
  collectReviewContext:async args=>collectReviewContext({...args,api}),
  loadProgress:async id=>rows.get(id)||null,
  initProgress:async({reviewId,planHash,totalBatches})=>{
   if(rows.has(reviewId))return false;
   rows.set(reviewId,{plan_hash:planHash,total_batches:totalBatches,
    completed_batches:0,results_json:'[]'});return true;
  },
  saveProgress:async({reviewId,planHash,previousBatches,completedBatches,results})=>{
   const row=rows.get(reviewId);
   if(row.plan_hash!==planHash||row.completed_batches!==previousBatches)return false;
   Object.assign(row,{completed_batches:completedBatches,results_json:JSON.stringify(results)});
   return true;
  },
  reserveModelCalls:async count=>({allowed:count<=4}),
  reviewWithAI:async(_batch,opts)=>{
   modelInputs.push(opts);calls++;
   return {summary:'Synthetic model, no findings',findings:[]};
  },
  postReview:async()=>{posts++;throw Error('Should not post');}
 };
 try{
  const target={reviewId:42,repository:repo,number:953,headSha:sha,installationId:7,
   postMode:'dry-run',allowDraft:true};
  let result;
  do{result=await analyzePullRequestStep(target,deps);}while(result.status==='progress');
  assert.equal(result.status,'completed');
  assert.equal(result.posted,0);
  assert.equal(posts,0);
  assert.ok(calls>0&&calls<=4);
  assert.ok(modelInputs.every(o=>o.model==='DEEP'));
  assert.ok(modelInputs.every(o=>o.reviewContext.sourceFiles.includes('src/lib/company-directory-official-facts-errors.ts')));
 }finally{config.aiAutoModelRepositories=previousModels;config.aiContextRepositories=previousContext;}
});
