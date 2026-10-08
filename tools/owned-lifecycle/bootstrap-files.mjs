// Source metadata is inspected before any bytes. In particular MEMORY.md is
// rejected case-insensitively even when it occurs in an ancestor component.
import {open,lstat,realpath,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
export const fault=code=>Object.assign(new Error(code),{fixedCode:code});
export const need=(value,code)=>{if(!value)throw fault(code);};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function safePath(path,{relative=false,allowedEnvExamplePaths=[]}={}){
  need(typeof path==='string'&&path.length>0&&!path.includes('\0')&&(relative?!path.startsWith('/'):path.startsWith('/')),'path_invalid');
  const parts=relative?path.split('/'):path.split('/').slice(1);
  need(parts.every(p=>p&&p!=='.'&&p!=='..'&&p.toLowerCase()!=='memory.md'),'path_forbidden_before_bytes');
  need(parts.every(p=>!/^\.env(?:$|\.)/i.test(p)||(p==='.env.example'&&allowedEnvExamplePaths.includes(path))),'private_env_basename_before_bytes');
  return path;
}
export async function noLinks(path,options={}){safePath(path,options);let at='';for(const part of path.split('/').slice(1)){at+=`/${part}`;need(!(await lstat(at)).isSymbolicLink(),'path_link');}return path;}
const stamp=s=>['dev','ino','size','mode','uid','nlink','mtimeNs','ctimeNs'].map(k=>String(s[k])).join(':');
export async function readPinned(path,{max=268435456,owner=false,mode,executable=false,allowedEnvExamplePaths=[]}={}){
  await noLinks(path,{allowedEnvExamplePaths});const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const a=await fd.stat({bigint:true});need(a.isFile()&&a.nlink===1n&&a.size<=BigInt(max)&&(!owner||a.uid===BigInt(process.getuid()))&&(mode===undefined||(a.mode&0o777n)===BigInt(mode))&&(!executable||(a.mode&0o111n)!==0n),'file_invalid');
    const data=await fd.readFile(),b=await fd.stat({bigint:true}),named=await lstat(path,{bigint:true});need(stamp(a)===stamp(b)&&stamp(b)===stamp(named)&&data.length===Number(a.size),'file_changed');return {data,sha256:sha(data),bytes:data.length};
  }finally{await fd.close();}
}
// Installed dependency cache files may have stable hardlinks. This policy is
// separate from source/config/helpers and cannot weaken their single-link rule.
export async function readInstalledDependency(path,{max=268435456,executable=false,afterFirstRead}={}){
  await noLinks(path);const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const a=await fd.stat({bigint:true});need(a.isFile()&&a.nlink>=1n&&a.size<=BigInt(max)&&(!executable||(a.mode&0o111n)!==0n),'dependency_file_invalid');const data=await fd.readFile();
    if(afterFirstRead)await afterFirstRead();const second=Buffer.alloc(Number(a.size));let offset=0;while(offset<second.length){const row=await fd.read(second,offset,second.length-offset,offset);need(row.bytesRead>0,'dependency_short_read');offset+=row.bytesRead;}
    const b=await fd.stat({bigint:true}),named=await lstat(path,{bigint:true});need(stamp(a)===stamp(b)&&stamp(b)===stamp(named)&&data.length===Number(a.size)&&sha(data)===sha(second),'dependency_file_changed');return {data,sha256:sha(data),bytes:data.length,nlink:Number(a.nlink),stableHardlinksPermitted:true};
  }finally{await fd.close();}
}
export async function canonicalExecutable(path){safePath(path);const absolute=await realpath(path);await readPinned(absolute,{executable:true});return absolute;}
export async function ownedDirectory(path,{create=false}={}){
  safePath(path);if(create)await mkdir(path,{mode:0o700});await noLinks(path);const s=await lstat(path,{bigint:true});need(s.isDirectory()&&s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o700n,'directory_not_owned');return {dev:String(s.dev),ino:String(s.ino),uid:Number(s.uid),mode:Number(s.mode)};
}
export async function exclusive(path,data,mode=0o400){await ownedDirectory(dirname(path));safePath(path);const fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(data);await fd.sync();await fd.chmod(mode);}finally{await fd.close();}return {path,sha256:sha(data)};}
export const jsonBytes=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`);
export async function runMetadata(binary,args,cwd,max=8388608){
  safePath(cwd);need(args.every(x=>typeof x==='string'&&!x.includes('\0')),'metadata_arguments');
  return await new Promise((ok,bad)=>execFile(binary,args,{cwd,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'},encoding:'buffer',timeout:15000,maxBuffer:max},(e,out)=>e?bad(fault('metadata_command_failed')):ok(out)));
}
export function normalizeLegacyManifest(legacy,{head,tree}){
  need(/^[a-f0-9]{40}$/.test(head)&&/^[a-f0-9]{40}$/.test(tree),'manifest_commit_invalid');
  const entries=Array.isArray(legacy?.entries)?legacy.entries:legacy?.files;need(Array.isArray(entries)&&entries.length<=2000,'manifest_shape_invalid');
  const seen=new Set();let total=0;const files=entries.map(row=>{safePath(row.path,{relative:true,allowedEnvExamplePaths:['.env.example']});need(!seen.has(row.path)&&Number.isSafeInteger(row.bytes)&&row.bytes>=0&&/^[a-f0-9]{64}$/.test(row.sha256),'manifest_entry_invalid');seen.add(row.path);total+=row.bytes;need(total<=67108864,'manifest_size_limit');return {path:row.path,bytes:row.bytes,sha256:row.sha256,mode:row.mode,blob:row.blob};});
  need(!Number.isSafeInteger(legacy.files)||legacy.files===files.length,'manifest_count_mismatch');return {kind:'linux-full-goal-public-source-manifest-v1',head,tree,files,bytes:total};
}
export async function capturePublicSource({sourceRoot,expectedHead,expectedTree,git='/usr/bin/git',minimumFiles=800,ci=null}){
  await noLinks(sourceRoot);need(/^[a-f0-9]{40}$/.test(expectedHead),'expected_head_invalid');
  const text=async args=>(await runMetadata(git,['-C',sourceRoot,...args],sourceRoot)).toString('utf8').trim();
  need(await text(['rev-parse','--show-toplevel'])===sourceRoot&&await text(['rev-parse','--is-bare-repository'])==='false','source_not_standalone_public_checkout');
  const checkedOutHead=await text(['rev-parse','HEAD']),tree=await text(['rev-parse',`${expectedHead}^{tree}`]),checkedOutTree=await text(['rev-parse','HEAD^{tree}']);
  need(/^[a-f0-9]{40}$/.test(tree)&&checkedOutTree===tree&&(!expectedTree||expectedTree===tree),'checked_out_tree_unbound');
  // Git's %P output honors shallow grafts and can suppress real parent IDs.
  // Read only this public commit object's header, never ancestor history.
  const commitHeader=(await text(['cat-file','-p','HEAD'])).split('\n\n',1)[0],parents=commitHeader.split('\n').filter(x=>x.startsWith('parent ')).map(x=>x.slice(7));need(parents.every(x=>/^[a-f0-9]{40}$/.test(x))&&commitHeader.split('\n').includes(`tree ${checkedOutTree}`),'checkout_commit_header_invalid');need(checkedOutHead===expectedHead||(parents.length===2&&parents.includes(expectedHead)),'checkout_not_head_or_exact_tree_merge');
  if(ci)need(ci.kind==='github-actions'&&/^[0-9]{1,20}$/.test(ci.runId)&&/^[1-9][0-9]{0,3}$/.test(ci.attempt)&&ci.checkedOutSha===checkedOutHead&&ci.expectedHead===expectedHead,'ci_provenance_unbound');
  const raw=await runMetadata(git,['-C',sourceRoot,'ls-tree','-r','-z','--full-tree',expectedHead],sourceRoot),rows=[];
  // Complete metadata preflight. No file, blob or forbidden basename is read.
  for(const entry of raw.toString('utf8').split('\0').filter(Boolean)){const tab=entry.indexOf('\t');need(tab>0,'tree_metadata_invalid');const prefix=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);safePath(path,{relative:true,allowedEnvExamplePaths:['.env.example']});need(prefix.length===3&&['100644','100755'].includes(prefix[0])&&prefix[1]==='blob'&&/^[a-f0-9]{40}$/.test(prefix[2]),'tree_entry_invalid');need(!path.split('/').some(p=>['.git','node_modules','target','dist','.caogen-private','eg-qa-appdata'].includes(p.toLowerCase())),'tree_private_or_build_path');rows.push({path,mode:prefix[0],blob:prefix[2]});}
  need(rows.length>=minimumFiles&&rows.length<=2000,'source_count_invalid');
  for(const row of rows){const absolute=`${sourceRoot}/${row.path}`,file=await readPinned(absolute,{max:67108864,allowedEnvExamplePaths:row.path==='.env.example'?[absolute]:[]});const gitBlob=createHash('sha1').update(Buffer.from(`blob ${file.bytes}\0`)).update(file.data).digest('hex');need(gitBlob===row.blob,'working_file_not_public_blob');row.bytes=file.bytes;row.sha256=file.sha256;}
  const manifest=normalizeLegacyManifest({entries:rows},{head:expectedHead,tree});
  return {...manifest,provenance:{checkedOutHead,checkedOutTree,parents,actualCheckoutRead:true,ci:ci??{kind:'local-public-checkout',nativeExecution:false},desktopAncestorHistoryIncluded:false,forbiddenNamesRejectedBeforeBytes:true}};
}
export async function verifyPublicSource(sourceRoot,manifest){
  // Recheck the exact whitelist; never enumerate untracked workspace contents.
  for(const row of manifest.files)safePath(row.path,{relative:true,allowedEnvExamplePaths:['.env.example']});
  for(const row of manifest.files){const absolute=`${sourceRoot}/${row.path}`,file=await readPinned(absolute,{max:67108864,allowedEnvExamplePaths:row.path==='.env.example'?[absolute]:[]});need(file.sha256===row.sha256&&file.bytes===row.bytes,'public_source_changed');}
  return {files:manifest.files.length,bytes:manifest.bytes,whitelistOnly:true,unchanged:true};
}
export async function preflightCargoConfiguration(sourceRoot,manifest){
  await noLinks(sourceRoot);need(manifest&&Array.isArray(manifest.files),'cargo_public_manifest_missing');let directory=sourceRoot;const checked=[],allowed=[];
  for(;;){const cargo=`${directory==='/'?'':directory}/.cargo`;let cargoStat;try{cargoStat=await lstat(cargo);}catch(e){need(e.code==='ENOENT','cargo_metadata_failed');}
    if(cargoStat){need(cargoStat.isDirectory()&&!cargoStat.isSymbolicLink(),'ambient_cargo_directory_rejected');for(const leaf of ['config','config.toml']){const path=`${cargo}/${leaf}`;let s;try{s=await lstat(path);}catch(e){need(e.code==='ENOENT','cargo_metadata_failed');}checked.push(path);if(s){const relative=`.cargo/${leaf}`,known=directory===sourceRoot&&manifest.files.find(x=>x.path===relative);need(known&&s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'ambient_cargo_configuration_rejected_before_bytes');allowed.push({path,sha256:known.sha256,bytes:known.bytes});}}}
    else checked.push(`${cargo}/config`,`${cargo}/config.toml`);if(directory==='/')break;directory=dirname(directory);
  }
  return {metadataOnly:true,ancestorAndUntrackedConfigurationsRejected:true,checked,publicTrackedSourceConfigurations:allowed};
}
