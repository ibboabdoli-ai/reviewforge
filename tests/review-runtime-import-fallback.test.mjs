import test from 'node:test';
import assert from 'node:assert/strict';
import {collectReviewContext} from '../src/review-context.mjs';

const sha='f'.repeat(40), repository='sample/runtime-imports';

async function inspect({specifier,implementation,includeMatchingTest=false,testSpecifier='../src/app/components/Widget',extraSources={},changedSourcePath='src/app/page.tsx',oversizedPaths=[],additionalChangedSources=[],sourceTextOverride=null,testTextOverride=null}) {
  const sourcePath=changedSourcePath;
  const sourceText=sourceTextOverride??`import {Widget} from "${specifier}";\nexport const action=Widget;`;
  const testPath='tests/page.test.ts';
  const testText=testTextOverride??`import {Widget} from "${testSpecifier}";\nexpect(Widget).toBeDefined();`;
  const files=[{filename:sourcePath,status:'modified',
    patch:`@@ -1,1 +1,2 @@\n import {Widget} from "${specifier}";\n+export const action=Widget;`}];
  if(includeMatchingTest)files.push({filename:testPath,status:'modified',
    patch:'@@ -0,0 +1,1 @@\n+expect(Widget).toBeDefined();'});
  for(const path of additionalChangedSources)files.push({filename:path,status:'modified',
    patch:'@@ -1,1 +1,1 @@\n+export const Widget={changed:true};'});
  const sourceFiles={
    [sourcePath]:sourceText,
    [testPath]:testText,
    [implementation]:'export const Widget={authorized:true};',
    ...extraSources
  };
  const requested=[];
  const api=async(path,token)=>{
    assert.equal(token,'fixture');
    const match=path.match(/^\/repos\/sample\/runtime-imports\/contents\/(.+)\?ref=([a-f0-9]{40})$/);
    assert.ok(match,'Only pinned source requests are permitted');
    assert.equal(match[2],sha);
    const filepath=decodeURIComponent(match[1]);
    requested.push(filepath);
    if(!Object.hasOwn(sourceFiles,filepath))throw new Error('GitHub 404: Not Found');
    const value=sourceFiles[filepath];
    return {type:'file',encoding:'base64',size:oversizedPaths.includes(filepath)?55001:Buffer.byteLength(value),
      content:Buffer.from(value).toString('base64')};
  };
  const context=await collectReviewContext({repository,sha,files,api,token:'fixture'});
  assert.equal(context.headSha,sha);
  assert.ok(context.totalChars<=12000);
  return {context,requested};
}

test('runtime .tsx fallback survives a matching test import without being shadowed',async()=>{
  const implementation='src/app/components/Widget.tsx';
  const {context,requested}=await inspect({specifier:'./components/Widget',
    implementation,includeMatchingTest:true});
  assert.ok(requested.includes('src/app/components/Widget.ts'),
    'The first .ts candidate should be attempted and return 404');
  assert.ok(requested.includes(implementation),'The .tsx fallback must be tried');
  assert.ok(context.sourceFiles.includes(implementation),
    'The actual .tsx runtime dependency must be given to the reviewing model');
  assert.ok(context.testLinks.some(link=>link.test==='tests/page.test.ts'&&link.implementation===implementation),
    'The included runtime dependency must retain its associated behavior-test link');
  assert.match(context.snippets.find(s=>s.path===implementation)?.text||'',/authorized/);
});

test('runtime @/ alias resolves a JavaScript dependency after non-existent TypeScript alternatives',async()=>{
  const implementation='src/lib/tenant-service.js';
  const {context,requested}=await inspect({specifier:'@/lib/tenant-service',implementation});
  assert.ok(requested.includes(implementation));
  assert.ok(context.sourceFiles.includes(implementation));
});

test('runtime extensionless import resolves a directory index module',async()=>{
  const implementation='src/app/components/Widget/index.tsx';
  const {context,requested}=await inspect({specifier:'./components/Widget',implementation});
  assert.ok(requested.includes(implementation));
  assert.ok(context.sourceFiles.includes(implementation));
});

test('runtime dotted module basename resolves its .ts implementation',async()=>{
  const implementation='src/lib/tenant.service.ts';
  const {context,requested}=await inspect({specifier:'@/lib/tenant.service',implementation});
  assert.ok(requested.includes(implementation),'Dotted runtime imports must try .ts');
  assert.ok(context.sourceFiles.includes(implementation),'Include the runtime module');
});

test('test-only dotted import resolves .tsx and preserves the test link',async()=>{
  const implementation='src/lib/pricing.config.tsx';
  const {context,requested}=await inspect({
    specifier:'./components/missing-unrelated',implementation,
    includeMatchingTest:true,testSpecifier:'../src/lib/pricing.config'
  });
  assert.ok(requested.includes('src/lib/pricing.config.ts'),'Try .ts before .tsx');
  assert.ok(requested.includes(implementation),'Try .tsx when .ts is absent');
  assert.ok(context.sourceFiles.includes(implementation),'Include the test-linked module');
  assert.ok(context.testLinks.some(link=>link.test==='tests/page.test.ts'&&link.implementation===implementation));
});

// Regression: explicit test imports must resolve their own candidate, rather
// than inheriting the first existing file from a different runtime import.
test('explicit .tsx behavior test import links to .tsx when runtime resolves .ts',async()=>{
  const runtime='src/app/components/Widget.ts';
  const explicit='src/app/components/Widget.tsx';
  const {context}=await inspect({
    specifier:'./components/Widget',implementation:runtime,includeMatchingTest:true,
    testSpecifier:'../src/app/components/Widget.tsx',
    extraSources:{[explicit]:'export const Widget={tsx:true};'}
  });
  assert.ok(context.sourceFiles.includes(runtime),'Runtime import resolves the .ts file');
  assert.ok(context.sourceFiles.includes(explicit),'Explicit test import must also include .tsx');
  assert.ok(context.testLinks.some(l=>l.test==='tests/page.test.ts'&&l.implementation===explicit),
    'Test relationship must point to the explicitly imported .tsx implementation');
  assert.ok(!context.testLinks.some(l=>l.test==='tests/page.test.ts'&&l.implementation===runtime),
    'Do not attach a misleading test relationship to the unrelated .ts fallback');
});

// A changed .tsx source is not proof that an extensionless test import resolves
// to it: an unchanged .ts sibling can take precedence at the same commit.
test('test import must prefer .ts sibling to an already included .tsx source',async()=>{
  const tsx='src/app/components/Widget.tsx';
  const ts='src/app/components/Widget.ts';
  const {context,requested}=await inspect({
    changedSourcePath:tsx,
    specifier:'./missing-dependency',
    implementation:tsx,
    includeMatchingTest:true,
    testSpecifier:'../src/app/components/Widget',
    extraSources:{[ts]:'export const Widget={typescript:true};'}
  });
  assert.ok(requested.includes(ts),'Must probe higher-priority .ts before attributing the .tsx source');
  assert.ok(context.sourceFiles.includes(ts),'Include the actual source referenced by the test');
  assert.ok(context.testLinks.some(l=>l.test==='tests/page.test.ts'&&l.implementation===ts),
    'The extensionless test import resolves to the .ts sibling');
  assert.ok(!context.testLinks.some(l=>l.test==='tests/page.test.ts'&&l.implementation===tsx),
    'Never link a test to the unrelated already-included .tsx module');
});

// When the preferred source exists but exceeds the context size limit, its
// existence is unknown to the sampler, not equivalent to a GitHub 404.
// A lower-priority sibling must not masquerade as the runtime dependency.
test('oversized .ts runtime dependency does not silently select .tsx fallback',async()=>{
  const preferred='src/app/components/Widget.ts';
  const fallback='src/app/components/Widget.tsx';
  const {context,requested}=await inspect({
    specifier:'./components/Widget',implementation:preferred,
    extraSources:{[fallback]:'export const Widget={wrongSibling:true};'},
    oversizedPaths:[preferred]
  });
  assert.ok(requested.includes(preferred),'The preferred candidate was inspected');
  assert.ok(!requested.includes(fallback),'An oversized preferred candidate is not a 404');
  assert.ok(!context.sourceFiles.includes(fallback),
    'Do not send an unrelated fallback source as the runtime dependency');
});

// A changed .tsx is not evidence that runtime extensionless import resolves to it.
// An unchanged .ts sibling has higher precedence and must still be probed.
test('runtime import prefers .ts over already included .tsx sibling',async()=>{
  const preferred='src/app/components/Widget.ts';
  const changedFallback='src/app/components/Widget.tsx';
  const {context,requested}=await inspect({
    specifier:'./components/Widget',implementation:preferred,
    additionalChangedSources:[changedFallback],
    extraSources:{[changedFallback]:'export const Widget={tsxOnly:true};'}
  });
  assert.ok(requested.includes(preferred),'Resolve higher-priority .ts even when .tsx is already included');
  assert.ok(context.sourceFiles.includes(preferred),'Send the true runtime dependency, not only the changed sibling');
});


// Regression: a runtime side-effect import is a real dependency. The old
// collector only recognized `from` and dynamic `import(` syntax.
test('side-effect runtime import includes its SHA-pinned dependency',async()=>{
  const implementation='src/app/components/register.ts';
  const {context,requested}=await inspect({
    specifier:'./unused',implementation,
    sourceTextOverride:'import "./components/register";\\nexport const ready=true;'.replace('\\n','\n')
  });
  assert.ok(requested.includes(implementation),
    'The side-effect import must be resolved even without a from clause');
  assert.ok(context.sourceFiles.includes(implementation),
    'Include the side-effect dependency for review');
});

// A changed behavior test can load a runtime module via a bare side-effect
// import. Its SHA-pinned implementation must be included and linked.
test('side-effect import in a changed behavior test links its implementation',async()=>{
  const implementation='src/app/components/register.ts';
  const {context,requested}=await inspect({
    specifier:'./unused-runtime',implementation,includeMatchingTest:true,
    testTextOverride:'import "../src/app/components/register";\\nexpect(true).toBe(true);'.replace('\\n','\n')
  });
  assert.ok(requested.includes(implementation),'Implementation must be fetched at immutable SHA');
  assert.ok(context.sourceFiles.includes(implementation),'Implementation must reach review context');
  assert.ok(context.testLinks.some(l=>l.test==='tests/page.test.ts'&&l.implementation===implementation),
    'The behavior-test relationship must be preserved');
});
