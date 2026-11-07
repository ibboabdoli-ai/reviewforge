import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReviewContext, importedPaths, projectRuleExcerpts, safeContextPath, sourceExcerpt } from '../src/review-context.mjs';
import { addedLines, validateFindings } from '../src/reviewer.mjs';
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
test('runtime alias imports resolve within the same safe repository namespace',()=>{
 assert.deepEqual(importedPaths('src/api/checkout.ts',
   'import {current} from "@/lib/billing-state";'),['src/lib/billing-state.ts']);
 assert.deepEqual(importedPaths('src/api/checkout.ts',
   'import x from "@/../../credentials";'),[]);
});
test('focused runtime imports outrank unrelated test mocks within a bounded context',async()=>{
 const target='c'.repeat(40),files=[
  {filename:'src/lib/payment-flow.ts',status:'modified',patch:'@@ -1,1 +1,2 @@\n import {state} from "@/lib/payment-state";\n+export const result=state;'},
  {filename:'tests/payment-flow.test.ts',status:'modified',patch:'@@ -1,1 +1,2 @@\n import "../src/lib/mock-a";\n+expect(result).toBeDefined();'}
 ];
 const bodies={
  'src/lib/payment-flow.ts':'import {state} from "@/lib/payment-state";\nexport const result=state;',
  'src/lib/payment-state.ts':'export const state={paid:true};',
  'tests/payment-flow.test.ts':'import "../src/lib/mock-a";\nimport "../src/lib/mock-b";\nimport "../src/lib/mock-c";\nexpect(result).toBeDefined();',
  'src/lib/mock-a.ts':'export const a=1;',
  'src/lib/mock-b.ts':'export const b=1;',
  'src/lib/mock-c.ts':'export const c=1;'
 };
 const requests=[];
 const api=async(path,token)=>{
  assert.equal(token,'fixture');assert.ok(path.endsWith('?ref='+target));
  const filename=decodeURIComponent(path.split('/contents/')[1].split('?ref=')[0]);
  requests.push(filename);
  if(!(filename in bodies))throw new Error('GitHub 404: Not Found');
  const body=bodies[filename];return {type:'file',encoding:'base64',size:Buffer.byteLength(body),
   content:Buffer.from(body).toString('base64')};
 };
 const context=await collectReviewContext({repository:repo,sha:target,files,token:'fixture',api});
 assert.ok(context.sourceFiles.includes('src/lib/payment-state.ts'));
 assert.ok(context.totalChars<=12000);
 assert.ok(requests.every(path=>path==='.coderabbit.yaml'||safeContextPath(path)));
});
test('project guidance is only a scoped, untrusted excerpt',()=>{
 const rules=projectRuleExcerpts(configFile,['src/lib/x.ts','tests/x.test.ts']);
 assert.match(rules,/mixed company-record/);
 assert.match(rules,/tests fail/);
 assert.doesNotMatch(rules,/auto_reply/);
 assert.equal(projectRuleExcerpts(configFile,['public/other.html']),'');
});
test('vetted workflow YAML guidance is selected for security-sensitive diffs',()=>{
 const rules=[
  'reviews:',
  '  path_instructions:',
  '    - path: ".github/workflows/**"',
  '      instructions: |',
  '        Treat workflow changes as security-sensitive.',
  '        Reject privileged execution of untrusted PR code.'
 ].join('\n');
 const selected=projectRuleExcerpts(rules,['.github/workflows/ci.yml']);
 assert.match(selected,/security-sensitive/);
 assert.match(selected,/untrusted PR code/);
 assert.equal(projectRuleExcerpts(rules,['src/lib/company-directory-public-search.ts']),'');
 assert.equal(projectRuleExcerpts(rules,['.github/workflows/.env']),'');
 assert.equal(projectRuleExcerpts(rules,['.github/workflows/../ci.yml']),'');
});

test('source excerpts include changed hunks with source line labels',()=>{
 const excerpt=sourceExcerpt(sourceB,files[1].patch);
 assert.match(excerpt,/L521:|L522:/);
 assert.ok(excerpt.length<=2700);
});
test('PR953-style queue change selects deep model and specialist review skill',()=>{
 const choice=selectReviewModel(files,{fastModel:'FAST',deepModel:'DEEP',enhancedRisk:true});
 assert.equal(choice.model,'DEEP');
 assert.equal(choice.tier,'deep');
 assert.match(choice.reason,/high-risk/);
 assert.equal(selectReviewModel(files,{fastModel:'FAST',deepModel:'DEEP'}).model,'FAST');
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
  assert.ok(modelInputs.every(o=>o.model===config.openai.modelDeep));
  assert.ok(modelInputs.every(o=>o.reviewContext.sourceFiles.includes('src/lib/company-directory-official-facts-errors.ts')));
 }finally{config.aiAutoModelRepositories=previousModels;config.aiContextRepositories=previousContext;}
});

test('final-gate context pins a workflow and its live adapter, not just test snippets',async()=>{
  // Synthetic version of the PR962 source-selection problem: two adjacent
  // workflow patches would previously crowd the live adapter out entirely.
  const targetSha='b'.repeat(40), files=[
    {filename:'.github/workflows/ci.yml',status:'modified',
      patch:'@@ -1,1 +1,2 @@\n original\n+const receiptCount = parseReceipt(body);'},
    {filename:'.github/workflows/proffera-automerge.yml',status:'modified',
      patch:'@@ -1,1 +1,2 @@\n original\n+const canMerge = receiptCount === 1;'},
    {filename:'.github/workflows/proffera-final-gate-wakeup.yml',status:'modified',
      patch:'@@ -1,1 +1,2 @@\n original\n+const wakeupReceipt = parseReceipt(body);'},
    {filename:'scripts/supervisor-final-gate-live.mjs',status:'modified',
      patch:'@@ -1,1 +1,2 @@\n original\n+function cleanCodexComment(body) { return firstReceipt(body); }'},
    {filename:'tests/codex-review-receipt-gate.test.ts',status:'added',
      patch:'@@ -0,0 +1,1 @@\n+expect(checkReceipt("Reviewed commit: abc1234")).toBe(true);'}
  ];
  const sources={
    '.github/workflows/ci.yml':'original\nconst receiptCount = parseReceipt(body);\nif (receiptCount !== 1) throw Error("reject");',
    '.github/workflows/proffera-automerge.yml':'original\nconst canMerge = receiptCount === 1;',
    '.github/workflows/proffera-final-gate-wakeup.yml':'original\nconst wakeupReceipt = parseReceipt(body);',
    'scripts/supervisor-final-gate-live.mjs':'original\nfunction cleanCodexComment(body) { return body.match(/Reviewed commit:/g)?.[0]; }',
    'tests/codex-review-receipt-gate.test.ts':'expect(checkReceipt("Reviewed commit: abc1234")).toBe(true);'
  };
  const requests=[];
  const api=async(path,token)=>{
    requests.push(path);
    assert.equal(token,'fixture-token');
    const match=path.match(/^\/repos\/sample\/review-demo\/contents\/(.+)\?ref=([a-f0-9]{40})$/);
    assert.ok(match);
    assert.equal(match[2],targetSha);
    const filename=decodeURIComponent(match[1]);
    if(!Object.hasOwn(sources,filename))throw new Error('GitHub 404: Not Found');
    const content=sources[filename];
    return {type:'file',encoding:'base64',size:Buffer.byteLength(content),
      content:Buffer.from(content).toString('base64')};
  };
  const context=await collectReviewContext({repository:repo,sha:targetSha,files,token:'fixture-token',api});
  assert.deepEqual(context.sourceFiles.filter(f=>f.startsWith('.github/')||f.startsWith('scripts/')),
    ['.github/workflows/ci.yml','.github/workflows/proffera-automerge.yml',
     '.github/workflows/proffera-final-gate-wakeup.yml','scripts/supervisor-final-gate-live.mjs']);
  assert.match(context.snippets.map(s=>s.text).join('\n'),/receiptCount/);
  assert.match(context.snippets.map(s=>s.text).join('\n'),/cleanCodexComment/);
  assert.match(context.snippets.map(s=>s.text).join('\n'),/wakeupReceipt/);
  assert.ok(context.totalChars<=12000);
  assert.ok(requests.every(req=>req.includes('?ref='+targetSha)));
  assert.ok(requests.some(req=>req.includes('proffera-automerge.yml')));
  assert.ok(requests.some(req=>req.includes('proffera-final-gate-wakeup.yml')));
});
test('workflow and adapter context paths remain tightly constrained',()=>{
  for(const path of ['.github/workflows/ci.yml','.github/workflows/proffera-final-gate-wakeup.yaml',
    'scripts/supervisor-final-gate-live.mjs'])assert.equal(safeContextPath(path),true,path);
  for(const path of ['.github/workflows/../secrets.yml','.github/workflows/.env',
    '.github/other.yml','.github/workflows/secrets.yml','.github/workflows/ci.yml/other',
    'scripts/.env','scripts/credentials.mjs','scripts/../.env','scripts/id_rsa',
    'scripts/vendor/private-key.ts'])assert.equal(safeContextPath(path),false,path);
});

test('PR962-shaped long workflow adapter excerpt prioritizes changed SHA predicates',()=>{
  // Synthetic 320-line adapter: before the fix, a long unchanged region before
  // the hunk consumed the entire 1,500-character gate-context budget.
  const lines=Array.from({length:332},(_,i)=>i<14
    ? '// safe header '+i
    : 'const surrounding_'+i+" = '"+'x'.repeat(115)+"';");
  const first='const receiptMatches = parseTrustedReviewedCommits(source.body);';
  const second='if (receiptMatches.length !== 1) throw new Error("ambiguous receipt");';
  lines[317]=first;
  lines[318]=second;
  const patch='@@ -315,5 +315,5 @@\n context1\n context2\n context3\n+'+first+'\n+'+second;
  const excerpt=sourceExcerpt(lines.join('\n'),patch,1500);
  assert.match(excerpt,/L318: const receiptMatches = parseTrustedReviewedCommits/);
  assert.match(excerpt,/L319: if \(receiptMatches.length !== 1\)/);
  assert.ok(excerpt.length<=1500);
});

test('review patches preserve source lines starting with ++ and later findings',()=>{
  // A changed source line "++count" is encoded as "+++count" in unified diff.
  // Earlier parsers treated it as a file header, shifting all following anchors.
  const patch=[
    '--- a/src/check.ts',
    '+++ b/src/check.ts',
    '@@ -1,1 +1,3 @@',
    ' const count = 0;',
    '+++count;',
    '+dangerousThing();'
  ].join('\n');
  assert.deepEqual([...addedLines(patch)],[2,3]);
  const finding={path:'src/check.ts',line:3,severity:'medium',
    category:'correctness',title:'Detect changed behavior',
    body:'The changed behavior introduces a reproducible correctness issue.',
    confidence:0.93};
  assert.equal(validateFindings([finding],[{filename:'src/check.ts',patch}]).length,1);

  // With many ++ statements, an incorrectly shifted hunk index misses the
  // final changed predicate even when there is ample excerpt budget.
  const lines=[
    ...Array.from({length:25},(_,i)=>'// HEAD '+i),
    ...Array.from({length:25},(_,i)=>'++count'+i+';'),
    'dangerousThing();'
  ];
  const longPatch='@@ -25,1 +25,27 @@\n '+lines[24]+'\n'
    +lines.slice(25).map(row=>'+'+row).join('\n');
  const excerpt=sourceExcerpt(lines.join('\n'),longPatch,1500);
  assert.match(excerpt,/L51: dangerousThing\(\);/);
  assert.ok(excerpt.length<=1500);
});

test('split file segments preserve all valid changed-line finding anchors',()=>{
  // Synthetic two-segment output of the bounded unified-diff splitter.
  // Each patch is independently anchored to the same NEW-file path.
  const path='src/review-gate.ts';
  const segments=[
    {filename:path,patch:'@@ -1,2 +1,3 @@\n const before=true;\n+rejectConflictingReceipt();\n const after=true;'},
    {filename:path,patch:'@@ -800,2 +801,3 @@\n const before=true;\n+rejectEditedReceipt();\n const after=true;'}
  ];
  const findings=[2,802].map(line=>({path,line,severity:'medium',
    category:'correctness',title:'Reject unsafe review evidence',
    body:'A synthetic test finding anchored on a changed line in this segment.',
    confidence:0.95}));
  // Before the fix, a Map keyed by filename replaced the first segment's
  // changed-line set with the second segment's set (1/2 accepted).
  assert.deepEqual(validateFindings(findings,segments).map(f=>f.line),[2,802]);
});
