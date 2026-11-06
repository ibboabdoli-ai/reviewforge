import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {spawn} from 'node:child_process';
import {trackChild} from './helpers/child-cleanup.mjs';

/** Model platform-specific signal/error ordering without relying on OS timing. */
function fakeChild(kill){
  return Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill,unref(){this.unrefed=true;}});
}
test('stalled graceful shutdown escalates, then removes files only after close',async()=>{
  const signals=[];let removed=false;
  const child=fakeChild(function(signal){signals.push(signal);if(signal==='SIGKILL')this.emit('close');return true;});
  const cleanup=trackChild(child,()=>{assert.deepEqual(signals,['SIGTERM','SIGKILL']);removed=true;},{graceMs:10,forceMs:10});
  await cleanup();assert.equal(removed,true);
});
test('kill error followed by forced close cleans files and preserves the original failure',async()=>{
  let removed=false;
  const child=fakeChild(function(signal){if(signal==='SIGTERM')this.emit('error',new Error('kill denied'));else this.emit('close');return false;});
  const primary=new Error('original assertion');
  await trackChild(child,()=>{removed=true;},{graceMs:10,forceMs:10})(primary);
  assert.equal(removed,true);assert.match(primary.message,/original assertion/);
  assert.ok(primary.cleanupError instanceof AggregateError);
});
test('failed forced shutdown is bounded and never deletes a live database',async()=>{
  let removed=false;
  const child=fakeChild(()=>false);
  await assert.rejects(trackChild(child,()=>{removed=true;},{graceMs:10,forceMs:10})(),/files retained/);
  assert.equal(removed,false);assert.equal(child.unrefed,true);
});
test('spawn/kill errors still surface when there was no prior test failure',async()=>{
  let removed=false;
  const child=fakeChild(function(){this.emit('close');return true;});
  const cleanup=trackChild(child,()=>{removed=true;});
  child.emit('error',new Error('spawn failed'));
  await assert.rejects(cleanup(),AggregateError);assert.equal(removed,true);
});
test('synchronous kill failure is reported after forced close and cleanup',async()=>{
  const killError=new Error('kill failed');let removed=false;
  const child=fakeChild(function(signal){
    if(signal==='SIGTERM')throw killError;
    this.emit('close');return true;
  });
  const cleanup=trackChild(child,()=>{removed=true;},{graceMs:10,forceMs:10});
  await assert.rejects(cleanup(),error=>
    error instanceof AggregateError&&error.errors.includes(killError));
  assert.equal(removed,true);
});
test('real child closes before cleanup on the host platform',async()=>{
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  let removed=false;
  const cleanup=trackChild(child,()=>{assert.ok(child.exitCode!==null||child.signalCode!==null);removed=true;});
  await once(child,'spawn');await cleanup();assert.equal(removed,true);
});
