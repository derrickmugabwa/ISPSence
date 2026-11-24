// Loopback-only frontend QA fixtures; never contacts PayHero or the application DB.
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const checkouts = new Map();
const offer = { id: 1,name: 'Day pass',amount_minor: 5000,currency: 'KES',duration_value: 1,duration_unit: 'day',download_bps: 10000000,upload_bps: 5000000,allowance_bytes: null,version: 1 };
const config = { template: 'minimal',brand_name: 'Sample Wi-Fi',headline: 'Get online.',welcome_text: '',primary_color: '#1e40af',background_color: '#eff4ff',logo_data_url: null,support_phone: '',support_label: '',terms_text: '',footer_text: '',show_packages: true,package_ids: [1] };
createServer(async (req,res) => {
  const send = (code,data) => { res.writeHead(code,{ 'Content-Type': 'application/json','Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const url = new URL(req.url,'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/public/portals/qa-network') return send(200,{ config,packages: [offer],version: 1,connection_available: false });
  if (req.method === 'GET' && url.pathname === '/api/public/payhero/availability') return send(200,{ enabled: true,mode: 'sandbox' });
  if (req.method === 'POST' && url.pathname === '/api/public/payhero/portals/qa-network/checkouts') {
    let text = ''; for await (const chunk of req) { text += chunk; if (text.length>4096) return send(413,{ error: 'Too large' }); }
    let body; try { body = JSON.parse(text); } catch { return send(400,{ error: 'Invalid body' }); }
    if (body.mode !== 'sandbox') return send(409,{ error: 'Only simulated sandbox UI fixtures are supported' });
    const existing = [...checkouts.values()].find((p) => p.key === body.request_key);
    if (existing) return send(202,existing.result);
    const id = randomUUID(), result = { id,reference: 'PAY-UI-FIXTURE',amount_minor: 5000,currency: 'KES',payment_status: 'pending',access_status: 'not_activated',attempt: { mode: 'sandbox',state: 'pending',receipt: null,last_error: null } };
    checkouts.set(id,{ key: body.request_key,token: body.checkout_token,result,polls: 0,failed: String(body.payer_phone).endsWith('2') });
    return send(202,result);
  }
  const id = url.pathname.split('/').pop(), checkout = checkouts.get(id);
  if (req.method === 'GET' && url.pathname.startsWith('/api/public/payhero/checkouts/') && checkout && checkout.token === req.headers['x-checkout-token']) {
    checkout.polls++;
    if (checkout.polls>=3) { checkout.result.attempt.state = checkout.failed ? 'failed' : 'succeeded'; checkout.result.attempt.receipt = checkout.failed ? null : 'SIMULATED-UI-RECEIPT'; }
    return send(200,checkout.result);
  }
  return send(404,{ error: 'UI fixture not found' });
}).listen(3001,'127.0.0.1',() => console.log('PayHero UI fixture API ready; no provider or database connection'));
