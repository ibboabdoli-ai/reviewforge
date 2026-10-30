import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectReviewContext,isTestPath,prioritizeBehaviorTests,testImplementationPaths
} from '../src/review-context.mjs';
import {reviewWithAI} from '../src/reviewer.mjs';
import {BEHAVIOR_TEST_REVIEW_METHOD} from '../src/review-method.mjs';
import {config} from '../src/config.mjs';

const repo='test-user/isolated-review',sha='a'.repeat(40);
const diff=(n,text)=>'@@ -'+n+',1 +'+n+',2 @@\n original\n+'+text;
const files=[
 {filename:'src/components/public-business/public-business-tracking.tsx',
  status:'modified',patch:diff(12,'export function sessionKey() { return getRandomKey(); }')},
 {filename:'src/features/quote-request/localized-quote-request-form.tsx',
  status:'modified',patch:diff(39,'export function switchLanguage() { return restore(); }')},
 {filename:'tests/unrelated-setup.test.ts',
  status:'added',patch:'@@ -0,0 +1,1 @@\n+expect(true).toBe(true);'},
 {filename:'tests/public-business-session-key.test.ts',
  status:'added',patch:'@@ -0,0 +1,2 @@\n+expect(sessionKey()).toBe("ab");\n+expect(sessionKey()).toBe("ab");'},
 {filename:'tests/quote-request-language-switch-guard.test.ts',
  status:'added',patch:'@@ -0,0 +1,2 @@\n+expect(result).toBe(true);\n+expect(change).toBe(true);'},
 {filename:'tests/public-form-protection-fingerprint-continuity.test.ts',
  status:'added',patch:'@@ -0,0 +1,2 @@\n+expect(sql()).toBeTruthy();\n+expect(mock).toBeDefined();'}
];
const sources={
 '.coderabbit.yaml':[
 'reviews:',
 '  path_instructions:',
 '    - path: "tests/**/*.{ts,tsx,js,jsx}"',
 '      instructions: |',
 '        Require a test to fail when its protected contract breaks.'
 ].join('\n'),
 'src/components/public-business/public-business-tracking.tsx':
  'export function sessionKey() { return window.crypto.randomUUID(); }\n',
 'src/features/quote-request/localized-quote-request-form.tsx':
  'import { persist } from "./draft-storage";\nexport function switchLanguage() { return persist(); }\n',
 'tests/public-business-session-key.test.ts':
  'import {sessionKey} from "@/components/public-business/public-business-tracking";\n'+
  'vi.mock("@/lib/public-form-protection",()=>({allowPublicSubmission:vi.fn()}));\n'+
  'it("reuses a constant key",()=>{expect(sessionKey()).toBe("ab");expect(sessionKey()).toBe("ab");});\n',
 'tests/quote-request-language-switch-guard.test.ts':
  'import {switchLanguage} from "@/features/quote-request/localized-quote-request-form";\n'+
  'it("navigates",()=>{expect(switchLanguage()).toBe(true)});\n',
 'tests/public-form-protection-fingerprint-continuity.test.ts':
  'import {allowPublicSubmission} from "@/lib/public-form-protection";\n'+
  'vi.mock("@/lib/db/server",()=>({getSql:vi.fn()}));\n'+
  'it("checks",()=>expect(allowPublicSubmission()).toBe(true));\n',
 'src/lib/public-form-protection.ts':
  'export async function allowPublicSubmission(input) {return updateBucket(input);}\n',
 'src/lib/db/server.ts':'export function getSql(){return sql;}\n',
 'src/features/quote-request/draft-storage.ts':
  'export function persist(){return true;}\n',
 'tests/unrelated-setup.test.ts':'it("works",()=>expect(true).toBe(true));\n'
};
function makeApi(){
 const requests=[];
 const api=async(path,token)=>{
   requests.push(path);
   assert.equal(token,'fixture-token');
   const p=path.match(/^\/repos\/test-user\/isolated-review\/contents\/(.+)\?ref=(.+)$/);
   assert.ok(p);assert.equal(p[2],sha);
   const key=decodeURIComponent(p[1]);
   if(!Object.hasOwn(sources,key))throw new Error('GitHub 404: Not Found');
   const source=sources[key];
   return {type:'file',encoding:'base64',size:Buffer.byteLength(source),
    content:Buffer.from(source).toString('base64')};
 };
 return {api,requests};
}
test('test implementation references resolve alias and relative imports without traversal',()=>{
 assert.equal(isTestPath('tests/example.test.ts'),true);
 assert.equal(isTestPath('src/components/example.tsx'),false);
 const refs=testImplementationPaths('tests/source.test.ts',[
   'import {sessionKey} from "@/components/public-business/public-business-tracking";',
   'vi.mock("@/lib/db/server",()=>{})',
   'import token from "../../.env";',
   'import bad from "https://example.com/secret";',
   'import x from "../src/../../credentials";'
 ].join('\n'));
 assert.ok(refs.some(p=>p.includes('src/components/public-business/public-business-tracking.tsx')));
 assert.ok(refs.some(p=>p.includes('src/lib/db/server.ts')));
 assert.ok(refs.every(p=>p.every(s=>!s.includes('..')&&!s.includes('.env')&&!s.includes('credentials'))));
});
test('rank test files using changed runtime behavior instead of first file in GitHub order',()=>{
 const ordered=prioritizeBehaviorTests(files.filter(f=>isTestPath(f.filename)),
  files.filter(f=>!isTestPath(f.filename)));
 assert.ok(ordered.indexOf(files[3])<ordered.indexOf(files[2]));
 assert.ok(ordered.indexOf(files[4])<ordered.indexOf(files[2]));
});
test('source context connects changed tests to implementation, bounded and immutable',async()=>{
 const {api,requests}=makeApi();
 const result=await collectReviewContext({repository:repo,sha,files,token:'fixture-token',api});
 assert.ok(result.totalChars<=12000);
 assert.ok(result.sourceFiles.includes('tests/public-business-session-key.test.ts'));
 assert.ok(result.sourceFiles.includes('tests/quote-request-language-switch-guard.test.ts'));
 assert.ok(result.testLinks.some(x=>x.test==='tests/public-business-session-key.test.ts' &&
  x.implementation==='src/components/public-business/public-business-tracking.tsx'));
 assert.ok(result.testLinks.some(x=>x.test==='tests/quote-request-language-switch-guard.test.ts' &&
  x.implementation==='src/features/quote-request/localized-quote-request-form.tsx'));
 assert.ok(result.sourceFiles.includes('src/lib/public-form-protection.ts')||
   result.sourceFiles.includes('src/lib/db/server.ts'));
 assert.ok(requests.every(x=>x.includes('?ref='+sha)));
 assert.equal(result.headSha,sha);
});
test('one mocked AI request contains independent behavioral and test-mutation checks',async()=>{
 const priorKey=config.openai.apiKey,oldFetch=globalThis.fetch;
 let requests=0,requestBody;
 try{
   config.openai.apiKey='fixture-not-a-real-secret';
   globalThis.fetch=async(url,request)=>{
     requests++;
     assert.match(url,/\/responses$/);
     requestBody=JSON.parse(request.body);
     return {ok:true,json:async()=>({output:[{content:[{
       type:'output_text',text:JSON.stringify({summary:'No finding from synthetic fixture.',findings:[]})
     }]}]})};
   };
   const {api}=makeApi();
   const context=await collectReviewContext({repository:repo,sha,files,token:'fixture-token',api});
   const result=await reviewWithAI(files,{reviewContext:context});
   assert.equal(requests,1);
   assert.equal(result.findings.length,0);
   assert.equal(requestBody.store,false);
   assert.match(requestBody.instructions,/LENS A -- runtime correctness/);
   assert.match(requestBody.instructions,/LENS B -- test effectiveness/);
   assert.match(requestBody.instructions,/minimal plausible mutation/);
   assert.match(requestBody.input,/TEST-TO-IMPLEMENTATION RELATIONSHIPS/);
   assert.match(requestBody.input,/src\/components\/public-business\/public-business-tracking\.tsx/);
   assert.match(requestBody.input,/UNTRUSTED READ-ONLY CONTEXT/);
   assert.equal(requestBody.text.format.type,'json_schema');
   assert.match(BEHAVIOR_TEST_REVIEW_METHOD,/Do not assume a test ran/);
 }finally{globalThis.fetch=oldFetch;config.openai.apiKey=priorKey;}
});
