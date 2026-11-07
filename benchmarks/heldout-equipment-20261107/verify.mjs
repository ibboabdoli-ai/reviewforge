import assert from 'node:assert/strict';
import {canViewUnit} from './candidate/access.mjs';
import {reserveUnit} from './candidate/reservations.mjs';
import {returnUnit} from './candidate/returns.mjs';

const unit={id:'camera-1',organizationId:'studio',allowedUserIds:['owner']};
const owner={id:'owner',organizationIds:['studio']};
const colleague={id:'colleague',organizationIds:['studio']};
const outsider={id:'outsider',organizationIds:['other']};
assert.equal(canViewUnit(outsider,unit),false);
assert.equal(canViewUnit(owner,unit),true);
assert.equal(canViewUnit(colleague,unit),true); // EQUIP-1: private-unit grant is ignored.

const rows=[];
let release;
const barrier=new Promise(resolve=>{release=resolve;});
let entered=0;
const quote=async()=>{entered++;await barrier;return 25;};
const first=reserveUnit({user:owner,unit,start:10,end:20,reservations:rows,quote});
const second=reserveUnit({user:owner,unit,start:10,end:20,reservations:rows,quote});
assert.equal(entered,2);
release();
assert.equal((await first).ok,true);
assert.equal((await second).ok,true);
assert.equal(rows.length,2); // EQUIP-2: concurrent overlap was accepted.
assert.equal((await reserveUnit({user:owner,unit,start:10,end:20,reservations:rows,quote})).reason,'unavailable');

const inventory=new Map([['camera-1',0],['camera-2',0]]);
const rental={unitId:'camera-1',returned:false};
assert.equal(returnUnit({reservation:rental,unit:{id:'camera-2'},inventory}).ok,true);
assert.equal(inventory.get('camera-1'),0);
assert.equal(inventory.get('camera-2'),1); // EQUIP-3: mismatched unit inventory changed.
assert.equal(returnUnit({reservation:rental,unit,inventory}).reason,'already-returned');
const clean={unitId:'camera-1',returned:false};
assert.equal(returnUnit({reservation:clean,unit,inventory}).ok,true);
assert.equal(inventory.get('camera-1'),1);
console.log('Held-out fixture verified: 3 reproducible defects and 3 negative controls.');
