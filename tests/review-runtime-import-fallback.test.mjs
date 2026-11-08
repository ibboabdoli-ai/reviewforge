import test from 'node:test';
import assert from 'node:assert/strict';
import {collectReviewContext} from '../src/review-context.mjs';

const sha='f'.repeat(40), repository='sample/runtime-imports';

async function inspect({specifier,implementation,includeMatchingTest=false,testSpecifier='../src/app/components/Widget'}) {
  const sourcePath='src/app/page.tsx';
  const sourceText=`import {Widget} from "${specifier}";\nexport const action=Widget;`;
  const testPath='tests/page.test.ts';
  const testText=`import {Widget} from "${testSpecifier}";\nexpect(Widget).toBeDefined();`;
  const files=[{filename:sourcePath,status:'modified',
    patch:`@@ -1,1 +1,2 @@\n import {Widget} from "${specifier}";\n+export const action=Widget;`}];
  if(includeMatchingTest)files.push({filename:testPath,status:'modified',
    patch:'@@ -0,0 +1,1 @@\n+expect(Widget).toBeDefined();'});
  const sourceFiles={
    [sourcePath]:sourceText,
    [testPath]:testText,
    [implementation]:'export const Widget={authorized:true};'
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
    return {type:'file',encoding:'base64',size:Buffer.byteLength(value),
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
