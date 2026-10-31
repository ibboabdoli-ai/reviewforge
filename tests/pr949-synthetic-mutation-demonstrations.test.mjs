import test from 'node:test';
import assert from 'node:assert/strict';

// Synthetic counterexamples only: never run or import Proffera, GitHub,
// databases, production tests, network calls or model requests.
// An original weak assertion accepting the mutation illustrates a blind spot,
// not proof that the actual production implementation is faulty.

test('storage cleanup snapshot misses temporary private writes',()=>{
 const writes=[],storage=new Map();
 const storageSet=(key,value)=>{writes.push({key,value});storage.set(key,value);};
 const sensitive='Synthetic Street 99';
 storageSet('temporary-private-data',sensitive);
 storage.delete('temporary-private-data');
 // A post-navigation getItem sees nothing: weak test still passes.
 assert.equal(storage.get('temporary-private-data'),undefined);
 // Record all writes before navigation: strong check catches the leak.
 assert.equal(writes.some(w=>w.value.includes(sensitive)),true);
});

test('cached session-key test cannot prove two fresh sessions use distinct randomness',()=>{
 function sessionKey(storage,generateBytes){
   const existing=storage.get('key');if(existing)return existing;
   const value=generateBytes();storage.set('key',value);return value;
 }
 const oneSession=new Map(),constantKey=()=> 'ab'.repeat(16);
 assert.equal(sessionKey(oneSession,constantKey),'ab'.repeat(16));
 assert.equal(sessionKey(oneSession,constantKey),'ab'.repeat(16)); // weak passes
 // Separate storage + varied random bytes must produce distinct sessions.
 const generated=[sessionKey(new Map(),()=> 'ab'.repeat(16)),
                  sessionKey(new Map(),()=> 'cd'.repeat(16))];
 assert.notEqual(generated[0],generated[1]);
 const mutated=[sessionKey(new Map(),constantKey),sessionKey(new Map(),constantKey)];
 assert.equal(mutated[0],mutated[1]); // strong distinctness test would fail
});

test('testing sessionKey alone misses removed fail-closed event fetch guard',()=>{
 const getKey=()=>'';const sent=[];
 const sendEvent=(guardPresent)=>{
   const key=getKey();
   if(guardPresent&&!key)return;
   sent.push({key});
 };
 assert.equal(getKey(),''); // original direct helper test passes
 sendEvent(false); // simulated mutation: guard removed
 assert.equal(sent.length,1); // incorrect dispatch happened
 sent.length=0;
 sendEvent(true);
 assert.equal(sent.length,0); // component-path negative assertion protects it
});

test('mocked SQL attempts result hides broken database conflict update',()=>{
 function allowPublicSubmission(sql){
   const rows=sql();
   return rows[0].attempts<=5;
 }
 const database={attempts:5};
 const brokenUpdater=()=>{database.attempts=1;return [{attempts:1}]};
 const mock=()=>[{attempts:6}];
 assert.equal(allowPublicSubmission(mock),false); // weak mocked test passes
 allowPublicSubmission(brokenUpdater);
 assert.notEqual(database.attempts,6); // persisted count is wrong
 const correctUpdater=()=>{database.attempts=6;return [{attempts:6}]};
 assert.equal(allowPublicSubmission(correctUpdater),false);
 assert.equal(database.attempts,6); // stronger check includes DB state
});

test('link-helper unit checks do not validate component href wiring',()=>{
 const safePhoneHref=value=>/^\+?[0-9]{6,20}$/.test(value)?'tel:'+value:undefined;
 assert.equal(safePhoneHref('+46701234567'),'tel:+46701234567');
 assert.equal(safePhoneHref('javascript:alert(1)'),undefined);
 const contact={phone:'javascript:alert(1)'};
 const brokenRender=booking=>({href:'tel:'+booking.phone});
 assert.equal(brokenRender(contact).href,'tel:javascript:alert(1)'); // unsafe action
 const safeRender=booking=>safePhoneHref(booking.phone)
   ?{href:safePhoneHref(booking.phone)}:null;
 assert.equal(safeRender(contact),null); // rendered-path negative assertion
});

test('copied email-validation pattern excludes a valid local-part apostrophe',()=>{
 const pattern=/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
 assert.equal(pattern.test('test@example.se'),true);
 assert.equal(pattern.test("o'connor@example.se"),false);
});
