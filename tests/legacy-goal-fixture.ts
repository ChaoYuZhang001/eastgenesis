/** Test-only explicit old array storage. Never calls or overrides production new-Goal enrollment. */
import type { Db } from "@/lib/db";
import { GOAL_SQL, getGoalForQuota } from "@/lib/db-goal";
import { newGoal, normalizeGoal, type Goal, type GoalInput } from "@/decision/goal";
export async function insertLegacyArrayGoal(db:Db,input:GoalInput,now=Date.now()):Promise<Goal>{
 if(input.id)throw Error("legacy fixture requires new synthetic identity");
 const g=newGoal(normalizeGoal(input),now);
 await db.execute(GOAL_SQL.insert,[g.id,g.project_id,g.description,g.instructions,g.routing_preference,g.status,JSON.stringify(g.rounds),g.max_llm_calls,g.used_llm_calls,g.created_at,g.updated_at]);
 const quota=await db.select<unknown[]>("SELECT key FROM app_meta WHERE key=$1",[`goal-quota:v1:${g.id}`]);
 if(quota.length!==0)throw Error("legacy fixture cannot enroll canonical quota");
 const stored=await getGoalForQuota(db,g.id);if(stored.quota)throw Error("legacy fixture unexpectedly enrolled");return stored;
}
