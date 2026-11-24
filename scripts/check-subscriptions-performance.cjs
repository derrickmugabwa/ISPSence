// Read-only timings. Logs counts and planner metrics, never customer records.
const assert=require('node:assert/strict');
async function main(){
 const db=require('/app/dist/config/database'),subs=require('/app/dist/modules/billing/subscriptions');
 let sql,params;const original=db.query;db.query=async(s,p)=>{sql=s;params=p;return original(s,p);};
 try{
 const previousJit=(await db.pool.query('SHOW jit')).rows[0].jit;
 const timings=[];for(let i=0;i<3;i++){const start=performance.now();const rows=await subs.subscriptionList();timings.push({ms:Math.round(performance.now()-start),rows:rows.length});}
 assert.equal((await db.pool.query('SHOW jit')).rows[0].jit,previousJit);
 console.log(JSON.stringify({subscription_list:timings,jit_setting_preserved:true}));
 sql=subs.SUBSCRIPTION_LIST_SQL??sql;params=[null];assert.ok(sql.startsWith('SELECT'));
 const client=await db.pool.connect();try{
 await client.query('BEGIN READ ONLY');
 for(const jit of ['on','off']){
 await client.query('SET LOCAL jit='+jit);
 const plan=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
 console.log(JSON.stringify({jit,execution_ms:plan['Execution Time'],planning_ms:plan['Planning Time'],estimated_cost:plan.Plan['Total Cost'],actual_rows:plan.Plan['Actual Rows'],jit_details:plan.JIT??null}));
 }
 await client.query('ROLLBACK');
 }finally{client.release();}
 }finally{await db.pool.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
