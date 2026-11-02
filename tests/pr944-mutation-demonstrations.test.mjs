import test from 'node:test';
import assert from 'node:assert/strict';

// Offline, synthetic, dependency-free mutation demonstrations. They model the
// observed call order and assertion shapes in Proffera PR #944, but do NOT
// execute, import, mutate, or write to Proffera. No network or secrets.
const validCompany={
  peOrgNr:'165563115707',orgNr:'5563115707',namn:'Synthetic AB',aeAnt:1
};
const validWorkplace={peOrgNr:'165563115707',cfarNr:12345678,aeStat:1,aeTyp:1};
const SECRET='synthetic-credential-NEVER-A-REAL-KEY';

async function simulatedScbFlow(company,workplace,{
  omitIdentityCheck=false,omitNameCheck=false
}={}){
  // The first request produces a company response.
  if(company.aeAnt!==1)throw new Error('incomplete workplace evidence');
  // The real adapter reads the workplace BEFORE calling companyRecord().
  if(workplace===undefined)throw new Error('second mocked HTTP response missing');
  if(workplace.cfarNr!==12345678)throw new Error('workplace mismatch');
  // These guards simulate companyRecord() and can be deliberately mutated.
  if(!omitIdentityCheck&&company.orgNr!=='5563115707')
    throw new Error('legal entity organization number mismatch');
  if(!omitNameCheck&&typeof company.namn!=='string')
    throw new Error('legal entity name is missing');
  return {organizationNumber:'5563115707'};
}
async function thrownMessage(work){
  try{await work();return null;}catch(e){return e?.message||String(e);}
}
function originalWeakCompanyCheck(message){return message!==null;}
function improvedCompanyCheck(message,required){
  return typeof message==='string'&&message.includes(required);
}
async function simulatedRateLimit(leakKey=false){
  throw new Error('SCB AFR v1 request failed with HTTP 429'+
    (leakKey?' key='+SECRET:''));
}
function originalWeakHttpCheck(message){
  return typeof message==='string'&&message.includes('HTTP 429');
}
function improvedHttpCheck(message){
  return originalWeakHttpCheck(message)&&!message.includes(SECRET);
}

test('PR944 company negative test can pass from a missing second mocked response, even with removed identity validation',async()=>{
  const badCompany={...validCompany,orgNr:'5569999999'};
  const original=await thrownMessage(()=>simulatedScbFlow(badCompany,undefined));
  const mutated=await thrownMessage(()=>simulatedScbFlow(badCompany,undefined,{omitIdentityCheck:true}));
  assert.match(original,/second mocked HTTP response missing/);
  assert.match(mutated,/second mocked HTTP response missing/);
  assert.equal(originalWeakCompanyCheck(original),true);
  assert.equal(originalWeakCompanyCheck(mutated),true);
});

test('PR944 company test with complete responses catches removed identity and name checks',async()=>{
  const badIdentity={...validCompany,orgNr:'5569999999'};
  const validIdentityError=await thrownMessage(()=>simulatedScbFlow(badIdentity,validWorkplace));
  const missingIdentityError=await thrownMessage(()=>simulatedScbFlow(
    badIdentity,validWorkplace,{omitIdentityCheck:true}));
  assert.equal(improvedCompanyCheck(validIdentityError,'organization number mismatch'),true);
  assert.equal(improvedCompanyCheck(missingIdentityError,'organization number mismatch'),false);
  assert.equal(missingIdentityError,null);

  const badName={...validCompany,namn:null};
  const validNameError=await thrownMessage(()=>simulatedScbFlow(badName,validWorkplace));
  const missingNameError=await thrownMessage(()=>simulatedScbFlow(
    badName,validWorkplace,{omitNameCheck:true}));
  assert.equal(improvedCompanyCheck(validNameError,'name is missing'),true);
  assert.equal(improvedCompanyCheck(missingNameError,'name is missing'),false);
  assert.equal(missingNameError,null);
});

test('PR944 HTTP status-only test survives API-key disclosure; a negative assertion kills the mutation',async()=>{
  const original=await thrownMessage(()=>simulatedRateLimit(false));
  const mutated=await thrownMessage(()=>simulatedRateLimit(true));
  assert.equal(originalWeakHttpCheck(original),true);
  assert.equal(originalWeakHttpCheck(mutated),true);
  assert.equal(improvedHttpCheck(original),true);
  assert.equal(improvedHttpCheck(mutated),false);
});
