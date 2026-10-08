import test from 'node:test';
import assert from 'node:assert/strict';
import { createLinuxProcessLifecycle } from './linux-launch-lifecycle.mjs';

test('unsupported real host refuses before any configuration getter',{skip:process.platform==='linux'?'separate mandatory native Linux suite applies':false},async()=>{
 let getterCalls=0;
 const config=new Proxy({}, {get(){getterCalls++;throw new Error('configuration_was_accessed');}});
 await assert.rejects(createLinuxProcessLifecycle(config),error=>error.fixedCode==='platform_unsupported');
 assert.equal(getterCalls,0);
});
