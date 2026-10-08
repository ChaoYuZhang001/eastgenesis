import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Db } from "@/lib/db";
import { asDb, loadSqlite, migratedDb, type RawDb, type SqliteModule } from "./sqlite-helper";
const state=vi.hoisted(()=>({db:null as Db|null}));
vi.mock("@/lib/db",()=>({withDb:async<T>(fn:(db:Db)=>Promise<T>)=>fn(state.db!)}));
import { saveGoal,listGoals,updateGoal } from "@/lib/db-goal";
let sqlite:SqliteModule,raw:RawDb;
beforeAll(async()=>{const s=await loadSqlite();expect(s).not.toBeNull();sqlite=s!;});
beforeEach(()=>{raw=migratedDb(sqlite);state.db=asDb(()=>raw);});
const one=async()=>saveGoal({description:"synthetic new Goal",max_llm_calls:3},1000);
describe("actual production new Goal enrollment policy",()=>{
 test("new desktop Goal explicitly prepares canonical quota and persists a versioned envelope",async()=>{
  const g=await one();const row=raw.prepare("SELECT rounds FROM goals WHERE id=$1").get({$1:g.id}) as {rounds:string};const storage=JSON.parse(row.rounds);expect(Array.isArray(storage)).toBe(false);expect(storage).toMatchObject({protocol:"inclusive-goal-quota-v1",goal_id:g.id,revision:0,rounds:[]});
  const q=raw.prepare("SELECT value FROM app_meta WHERE key=$1").get({$1:`goal-quota:v1:${g.id}`}) as {value:string};expect(JSON.parse(q.value)).toMatchObject({goal_id:g.id,limit:3,consumed:0,state:"prepared"});
 });
 test("enrolled Goal cap is fixed even before its first model call",async()=>{
  const g=await one();await expect(saveGoal({id:g.id,max_llm_calls:5},1001)).rejects.toMatchObject({code:"quota_cap_fixed"});expect((await listGoals())[0].max_llm_calls).toBe(3);
 });
 test("legacy array Goal retains original behavior without automatic quota creation",async()=>{
  await state.db!.execute("INSERT INTO goals(id,description,status,rounds,max_llm_calls,used_llm_calls,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8)",["goal-legacy","synthetic legacy","idle","[]",3,0,1000,1000]);await updateGoal("goal-legacy",{op:"record_llm_calls",count:1},1001);expect((await listGoals())[0].used_llm_calls).toBe(1);expect(await state.db!.select("SELECT key FROM app_meta WHERE key=$1",["goal-quota:v1:goal-legacy"])).toEqual([]);
 });
});
