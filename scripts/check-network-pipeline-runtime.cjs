// Read-only checks of the deployed local pipeline; no customer/router writes.
const assert = require('node:assert/strict');
const {pool} = require('/app/dist/config/database');
const {pipelineDiagnostics} = require('/app/dist/modules/billing/accountingPipeline');
async function main() {
  try {
    const data = await pipelineDiagnostics();
    assert.equal(data.authorization_enabled, false);
    const worker = data.health.find(row => row.name === 'network_pipeline');
    assert.ok(worker?.last_succeeded_at, 'Pipeline heartbeat missing');
    assert.equal(worker.last_code, null);
    assert.ok(Date.now() - new Date(worker.last_succeeded_at).getTime() < 30000, 'Pipeline heartbeat stale');
    const invalid = await pool.query("SELECT count(*)::int AS total FROM billing_provisioning_runs r JOIN billing_access_jobs j ON j.id=r.job_id WHERE r.state='confirmed' AND j.status='pending'");
    assert.equal(invalid.rows[0].total, 0);
    console.log('PASS: deployed pipeline heartbeat is fresh, diagnostics execute, confirmation states agree and live authorization remains blocked');
  } finally { await pool.end(); }
}
main().catch(error => {console.error(error.message);process.exitCode = 1;});
