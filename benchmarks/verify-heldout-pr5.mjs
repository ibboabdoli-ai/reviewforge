import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixtureRoot=resolve(process.argv[2]||'');
if(process.argv.length!==3)throw new Error('Usage: node benchmarks/verify-heldout-pr5.mjs <sandbox-fixture-checkout>');
const expectedSha='c4054f5e247514c80b76344eb1854e2345aa8037';
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:fixtureRoot,encoding:'utf8'}).trim();
assert.equal(head,expectedSha,'Refuse to score a different fixture commit');

const {invoicePreview}=await import(pathToFileURL(join(fixtureRoot,'src/services/invoice-preview.mjs')).href);
const {bookSeats}=await import(pathToFileURL(join(fixtureRoot,'src/services/seat-reservations.mjs')).href);
const {countTenantEvents}=await import(pathToFileURL(join(fixtureRoot,'src/lib/tenant-metrics.mjs')).href);
const invoices=[{id:910,tenantId:'tenant-a',number:'SYN-910',totalCents:2700,state:'issued'}];

const leak=invoicePreview(invoices,{tenantId:'tenant-b'},910);
assert.equal(leak?.id,910,'Expected the frozen vulnerable target to expose an unscoped invoice');
const scopedTwin=invoicePreview(invoices.filter(x=>x.tenantId==='tenant-b'),{tenantId:'tenant-b'},910);
assert.equal(scopedTwin,null,'A tenant-scoped lookup must refuse the other tenant');

let state={capacity:2,reserved:0},readers=0,release;
const ready=new Promise(resolve=>{release=resolve;});
const store={
  async load(){const snapshot={...state};readers++;if(readers===2)release();await ready;return snapshot;},
  async save(_event,next){state={...next};}
};
const attempts=await Promise.all([bookSeats(store,'fixture-event',2),bookSeats(store,'fixture-event',2)]);
assert.equal(attempts.filter(x=>x.accepted).length,2,'Expected two conflicting admissions with the frozen target');
assert.equal(state.reserved,2,'The second stale write overwrites the first');

const atomic={capacity:2,reserved:0,async reserveIfAvailable(_id,n){
  if(n>this.capacity-this.reserved)return false;
  this.reserved+=n;
  return true;
}};
const corrected=await Promise.all([
  atomic.reserveIfAvailable('fixture-event',2),atomic.reserveIfAvailable('fixture-event',2)]);
assert.deepEqual(corrected,[true,false],'A conditional atomic reservation allows at most one admission');
assert.deepEqual(countTenantEvents([
  {tenantId:'tenant-a',status:'completed'},{tenantId:'tenant-b',status:'failed'}
],'tenant-a'),{queued:0,completed:1,failed:0});

console.log(JSON.stringify({
  pinnedHead:head,baseUnitTests:'verified independently',
  witnesses:{crossTenantLeak:'reproduced',parallelOversubscription:'reproduced'},
  correctedTwins:{scopedLookup:'passed',atomicConditionalReserve:'passed'},
  negativeControl:'passed',
  note:'This witness does not run or score an AI reviewer'
},null,2));
