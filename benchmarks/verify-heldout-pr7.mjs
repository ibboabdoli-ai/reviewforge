import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';

const target=process.argv[2];
if(process.argv.length!==3||!target)throw new Error('Usage: node verify-heldout-pr7.mjs <sandbox checkout>');
const root=resolve(target), head='a628945d7533c7418aed344ed5f90a9a2ec8bc46';
const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(actual,head,'Use exactly the frozen sandbox HEAD');
const load=async path=>import(pathToFileURL(join(root,path)).href);
const {createTransactionPool}=await load('src/lib/mock-transaction-pool.mjs');
const {createBookingRepository}=await load('src/lib/booking-repository.mjs');
const {sendBookingNotice}=await load('src/services/booking-notice.mjs');
const {sendDepositReminder}=await load('src/services/deposit-reminder.mjs');
const {confirmDeposit}=await load('src/services/deposit-updates.mjs');
const workspace={id:'synthetic-ws',permissions:['notify-bookings','request-deposit']};
const booking={id:'id-1',workspaceId:workspace.id,status:'confirmed',
  depositStatus:'pending',customerEmail:'user@example.invalid',
  customerName:'Synthetic User',appointmentDate:'2026-11-09'};

const poolA=createTransactionPool();
let unlockLookup;
const lookupGate=new Promise(resolve=>{unlockLookup=resolve;});
const first=sendBookingNotice({pool:poolA,workspace,bookingId:booking.id,
  repository:{async get(){await lookupGate;return booking;}},
  transport:{async send(){}}});
for(let attempts=0;attempts<40&&!poolA.isHeld(workspace.id);attempts++)
  await new Promise(resolve=>setImmediate(resolve));
assert.equal(poolA.isHeld(workspace.id),true,'First notice holds lock');
const second=sendBookingNotice({pool:poolA,workspace,bookingId:booking.id,
  repository:createBookingRepository([booking]),transport:{async send(){}}});
try{
  await assert.rejects(second,/LOCK_TIMEOUT/,'Second lock acquisition must time out');
  assert.equal(poolA.isHeld(workspace.id),true,'Stalled callback keeps lock held');
}finally{unlockLookup();}
await first;
assert.equal(poolA.isHeld(workspace.id),false);

const poolB=createTransactionPool(),repository=createBookingRepository([booking]);
let startedSend,unlockSend;
const sendStarted=new Promise(resolve=>{startedSend=resolve;});
const sendGate=new Promise(resolve=>{unlockSend=resolve;});
const delivered=[];
const reminder=sendDepositReminder({pool:poolB,repository,workspace,bookingId:booking.id,
  transport:{async send(message){startedSend();await sendGate;delivered.push(message);}}});
await sendStarted;
assert.equal(poolB.isHeld(workspace.id),true);
const paid=await confirmDeposit({repository,workspace,bookingId:booking.id});
assert.equal(paid.updated,true);
assert.equal(repository.snapshot(booking.id).depositStatus,'paid');
unlockSend();
assert.equal((await reminder).status,'sent');
assert.equal(delivered.length,1,'Paid deposit still got stale reminder');
assert.equal(poolB.isHeld(workspace.id),false);
console.log(JSON.stringify({head,bugs:{unboundedLock:'REPRODUCED',
  staleDepositReminder:'REPRODUCED'},synthetic:true,networkCalls:0,paidModelCalls:0},null,2));
