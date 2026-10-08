import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,lstat,rename,rm,chmod,symlink,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeOperationWindow,acceptNativeAcknowledgement,readOwnedLifecycleJournal,createLinuxProcessLifecycle} from './linux-launch-lifecycle.mjs';

const completeRows=[
  {sequence:1,atNs:'100',event:'supervisor_ready',subreaper:true},
  {sequence:2,atNs:'200',event:'cleanup_complete',ownedCount:0,allReaped:true,unknownCount:0,failureCodes:[]},
];
const encode=rows=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
async function fixture(fn){
  const root=await realpath(await mkdtemp(join(tmpdir(),'eastgenesis-wrapper-journal-negative-')));await chmod(root,0o700);
  const path=join(root,'journal.jsonl');await writeFile(path,encode(completeRows),{mode:0o600,flag:'wx'});
  const s=await lstat(path,{bigint:true});const identity={dev:s.dev.toString(),ino:s.ino.toString(),uid:Number(s.uid),mode:Number(s.mode),nlink:Number(s.nlink)};
  try{return await fn({root,path,identity});}finally{await rm(root,{recursive:true,force:true});await assert.rejects(lstat(root),error=>error.code==='ENOENT');}
}
test('local operation deadline cannot expand beyond global remaining time',()=>{
  assert.equal(nativeOperationWindow(100n,1000000100n,5000),1000000100n);
  assert.equal(nativeOperationWindow(100n,10000000100n,5000),5000000100n);
  assert.throws(()=>nativeOperationWindow(100n,100n,5000),/global_deadline_exceeded/);
});
test('late ACK rejects even when the timer callback has not run',()=>{
  const end=nativeOperationWindow(100n,10000000100n,5000);
  assert.doesNotThrow(()=>acceptNativeAcknowledgement(end,end-1n));
  assert.throws(()=>acceptNativeAcknowledgement(end,end),/supervisor_reply_late/);
  assert.throws(()=>acceptNativeAcknowledgement(end,end+1n),/supervisor_reply_late/);
});
test('actual owned journal bounded readback preserves ordered cleanup record',()=>fixture(async({path,identity})=>{
  assert.deepEqual(await readOwnedLifecycleJournal(path,identity,{originNs:0n,hardEndNs:1000n}),completeRows);
}));
test('same bytes at replaced journal inode cannot supply cleanup proof',()=>fixture(async({root,path,identity})=>{
  await rename(path,join(root,'original-held.jsonl'));await writeFile(path,encode(completeRows),{mode:0o600,flag:'wx'});
  await assert.rejects(readOwnedLifecycleJournal(path,identity),/journal_identity_changed/);
}));
test('journal symlink and hardlink cannot supply cleanup proof',()=>fixture(async({root,path,identity})=>{
  await symlink(path,join(root,'alias.jsonl'));
  await assert.rejects(readOwnedLifecycleJournal(join(root,'alias.jsonl'),identity),/input_path_link/);
  await link(path,join(root,'hardlink.jsonl'));
  await assert.rejects(readOwnedLifecycleJournal(path,identity),/journal_identity_changed/);
}));
test('journal mode change cannot supply cleanup proof',()=>fixture(async({path,identity})=>{
  await chmod(path,0o644);await assert.rejects(readOwnedLifecycleJournal(path,identity),/journal_identity_changed/);
}));
test('case-insensitive memory basename rejects before reading owned fixture bytes',()=>fixture(async({root,path,identity})=>{
  const excluded=join(root,'memory.md');await rename(path,excluded);
  await assert.rejects(readOwnedLifecycleJournal(excluded,identity),/input_path_invalid/);
}));
test('journal byte cap rejects oversized actual file before reading contents',()=>fixture(async({path,identity})=>{
  await writeFile(path,Buffer.alloc(4194305,32));await assert.rejects(readOwnedLifecycleJournal(path,identity),/journal_identity_changed/);
}));
test('journal deadline and unknown child failure cannot become cleanup success',()=>fixture(async({path,identity})=>{
  await assert.rejects(readOwnedLifecycleJournal(path,identity,{originNs:0n,hardEndNs:200n}),/journal_clock_invalid/);
  await writeFile(path,encode([completeRows[0],{...completeRows[1],unknownCount:1}]));
  await assert.rejects(readOwnedLifecycleJournal(path,identity),/cleanup_journal_unverified/);
}));
test('Linux factory on macOS rejects before poison configuration access',{skip:process.platform!=='darwin'},async()=>{
  const poison=new Proxy({},{get(){throw Error('configuration_read');}});
  await assert.rejects(createLinuxProcessLifecycle(poison),/platform_unsupported/);
});
