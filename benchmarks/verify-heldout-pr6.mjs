import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

if(process.argv.length!==3)throw new Error('Usage: node benchmarks/verify-heldout-pr6.mjs <fixture checkout>');
const root=resolve(process.argv[2]);
const expected='5d414d485105e4795b86978679ef9cc106507360';
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(head,expected,'Pinned sandbox commit required');
const {activityPage}=await import(pathToFileURL(join(root,'src/services/activity-feed.mjs')).href);
const {dispatchNotice}=await import(pathToFileURL(join(root,'src/services/notice-dispatch.mjs')).href);
const {createNoticeStore}=await import(pathToFileURL(join(root,'src/lib/notice-store.mjs')).href);
const timestamp='2026-11-08T10:00:00Z';
const activity=['c','b','a'].map(id=>({id,tenantId:'tenant-north',state:'published',createdAt:timestamp}));
const first=activityPage(activity,{tenantId:'tenant-north',limit:1});
const second=activityPage(activity,{tenantId:'tenant-north',limit:1,cursor:first.nextCursor});
assert.equal(first.items[0]?.id,'c');
assert.equal(second.items.length,0,'Broken cursor hides remaining equal-timestamp events');
const corrected=activity.filter(e=>e.createdAt<first.nextCursor.createdAt||
  (e.createdAt===first.nextCursor.createdAt&&e.id<first.nextCursor.id));
assert.equal(corrected[0]?.id,'b');
const notice={id:'notice-07',to:'test@example.invalid',body:'synthetic'};
const store=createNoticeStore();
let calls=0,delivered=0;
const transport={async send(){calls++;if(calls===1)throw new Error('Synthetic transient failure');delivered++;}};
await assert.rejects(dispatchNotice(notice,store,transport),/transient failure/);
assert.equal((await dispatchNotice(notice,store,transport)).status,'duplicate');
assert.equal(delivered,0,'Retry was lost despite send failing');
const correctStore=createNoticeStore();
let tries=0;
const recovered=async()=>correctStore.withEventLock(notice.id,async()=>{
  if(await correctStore.wasSent(notice.id))return 'duplicate';
  tries++;
  if(tries===1)throw new Error('Synthetic transient failure');
  await correctStore.markSent(notice.id);return 'sent';
});
await assert.rejects(recovered(),/transient failure/);
assert.equal(await recovered(),'sent');assert.equal(tries,2);
console.log(JSON.stringify({head,red:{cursor:'REPRODUCED',retry:'REPRODUCED'},
  correctedTwins:{cursor:'PASS',retry:'PASS'},paidModelCalls:0,githubWrites:0},null,2));
