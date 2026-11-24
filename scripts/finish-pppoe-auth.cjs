const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
(async()=>{
  const text=await fs.readFile('/lab/fixture.env','utf8');
  const token=/^export PPPOE_DB_LAB_TOKEN=([a-f0-9]{64})$/m.exec(text)?.[1];
  assert.ok(token,'Missing disposable fixture token');
  const response=await fetch('http://127.0.0.1:3009/done',{method:'POST',headers:{'X-PPPoE-Lab-Token':token}});
  assert.equal(response.status,204,'Protocol accounting/readiness assertions failed');
  console.log('PASS: database-backed packet results and independent readiness evidence verified');
})().catch(e=>{console.error(e.message);process.exitCode=1});
