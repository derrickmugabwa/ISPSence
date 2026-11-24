// Run in the frontend check image with /previews mounted to an ignored output folder.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
require.extensions['.tsx'] = (mod,filename) => {
  const source = fs.readFileSync(filename,'utf8');
  const result = ts.transpileModule(source,{ compilerOptions: { module: ts.ModuleKind.CommonJS,jsx: ts.JsxEmit.ReactJSX,target: ts.ScriptTarget.ES2020 } });
  mod._compile(result.outputText,filename);
};
require.extensions['.css'] = () => {};
const { PortalView } = require('/frontend/src/components/billing/PortalView.tsx');
const css = fs.readFileSync('/frontend/src/components/billing/portal.css','utf8');
const packages = [
  { id: 1,name: 'Daily connection',amount_minor: 5000,currency: 'KES',duration_value: 1,duration_unit: 'day',download_bps: 5000000,upload_bps: 2000000,allowance_bytes: null,version: 1 },
  { id: 2,name: 'A week of Wi-Fi',amount_minor: 25000,currency: 'KES',duration_value: 1,duration_unit: 'week',download_bps: 10000000,upload_bps: 5000000,allowance_bytes: 20000000000,version: 1 },
];
const base = { template: 'classic',brand_name: 'Sample Wi-Fi',headline: 'Stay connected.',welcome_text: '',primary_color: '#166534',background_color: '#f1f5f2',logo_data_url: null,support_phone: '+1 202 555 0100',support_label: 'Support',terms_text: 'Please use this network responsibly. Contact support if you need help.',footer_text: '',show_packages: true,package_ids: [1,2] };
fs.mkdirSync('/previews',{ recursive: true });
for (const template of ['classic','split','minimal']) for (const compact of [false,true]) for (const appearance of ['light','dark']) {
  const config = { ...base,template,...(template === 'split' ? { primary_color: '#1e40af',background_color: '#eff4ff' } : template === 'minimal' ? { primary_color: '#7c2d12',background_color: '#faf5ef' } : {}) };
  const markup = renderToStaticMarkup(React.createElement(PortalView,{ config,packages,compact,preview: true,appearance,onSelectPackage: () => {} }));
  const name = `${template}${compact ? '-mobile' : ''}${appearance === 'dark' ? '-dark' : ''}`;
  fs.writeFileSync(`/previews/${name}.html`,`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · sample preview</title><style>body{margin:0;background:#e5e7eb} ${css}</style></head><body><div style="${compact ? 'max-width:390px;margin:0 auto;' : ''}">${markup}</div></body></html>`);
}
const escaped = renderToStaticMarkup(React.createElement(PortalView,{ config: { ...base,headline: '<script>alert(1)</script>',terms_text: '<img src=x onerror=alert(1)>' },packages: [] }));
assert.ok(escaped.includes('&lt;script&gt;')); assert.ok(!escaped.includes('<script>'));
assert.ok(escaped.includes('&lt;img')); assert.ok(!escaped.includes('<img src="x"'));
console.log('PASS: twelve light/dark previews rendered from the actual portal component; heading and terms markup escaped');

const selective = renderToStaticMarkup(React.createElement(PortalView,{ config: { ...base,package_display: { name: false,price: true,duration: false,download_speed: false,upload_speed: true,data_allowance: false } },packages: [packages[0]],onSelectPackage: () => {} }));
assert.ok(!selective.includes('<h3>')); assert.ok(!selective.includes('1 day')); assert.ok(!selective.includes('5 Mbps'));
assert.ok(selective.includes('2 Mbps up')); assert.ok(!selective.includes('Unlimited data')); assert.match(selective,/Ksh[^<]*50/);
assert.ok(selective.includes('Choose plan')); assert.ok(!selective.includes('Connect to Wi-Fi'));
console.log('PASS: selected package fields rendered; hidden fields and standalone connection button absent');
const { PortalPaymentDemo } = require('/frontend/src/components/billing/PortalPaymentDemo.tsx');
const themedCheckout = renderToStaticMarkup(React.createElement(PortalPaymentDemo,{ config: { ...base,primary_color: '#1e40af' },packages,initialPackageId: 1,appearance: 'dark' }));
assert.ok(themedCheckout.includes('--cp-brand:#1e40af'));
assert.ok(themedCheckout.includes('data-appearance="dark"'));
assert.match(css,/\.pd-primary\{background:var\(--cp-brand\);color:var\(--cp-on-brand\)/);
assert.ok(!/\.pd-primary\{background:#166534/.test(css));
console.log('PASS: checkout uses the selected portal brand color and appearance');
