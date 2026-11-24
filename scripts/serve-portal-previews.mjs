import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve('.local/portal-previews');
const allowed = new Set(['classic','split','minimal'].flatMap(t => ['', '-mobile'].flatMap(size => ['', '-dark'].map(mode => `${t}${size}${mode}.html`))));
createServer(async (req,res) => {
  const filename = (req.url ?? '').split('?')[0].slice(1);
  if (!allowed.has(filename)) { res.writeHead(404); res.end('Preview not found'); return; }
  try {
    const html = await readFile(resolve(root,filename));
    res.writeHead(200,{ 'Content-Type': 'text/html; charset=utf-8','Cache-Control': 'no-store','Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'" });
    res.end(html);
  } catch { res.writeHead(404); res.end('Preview not rendered'); }
}).listen(8787,'127.0.0.1',() => console.log('Static sample portal previews: http://127.0.0.1:8787/classic.html'));
