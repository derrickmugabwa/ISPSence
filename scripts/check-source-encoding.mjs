import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const decoder = new TextDecoder('utf-8',{ fatal: true });
const suspicious = /\u00c3|\u00c2|\u00e2[\u0080-\u00ff\u2000-\u20ff]|\ufffd/;
let checked = 0;
const failures = [];
async function scan(directory) {
  for (const entry of await readdir(directory,{ withFileTypes: true })) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) { await scan(path); continue; }
    if (!/\.(ts|tsx|css|mjs|cjs)$/.test(entry.name)) continue;
    checked++;
    try {
      const source = decoder.decode(await readFile(path));
      if (suspicious.test(source)) failures.push(`${path}: possible encoding corruption`);
    } catch { failures.push(`${path}: invalid UTF-8`); }
  }
}
await scan('frontend/src');
await scan('backend/src');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${checked} source files are valid UTF-8 with no known corruption patterns`);
