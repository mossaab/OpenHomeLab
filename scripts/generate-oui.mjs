import fs from 'node:fs';

const inputPath = process.argv[2];
if (!inputPath || !fs.existsSync(inputPath)) {
  console.error('Usage: node scripts/generate-oui.mjs <nmap-mac-prefixes-file>');
  process.exit(1);
}

const lines = fs.readFileSync(inputPath, 'utf8').split('\n');
const oui = {};
for (const line of lines) {
  if (!line || line.startsWith('#')) continue;
  const [prefix, ...rest] = line.trim().split(/\s+/);
  if (!/^[0-9a-fA-F]{6}$/.test(prefix)) continue;
  const vendor = rest.join(' ').trim();
  if (!vendor) continue;
  oui[prefix.toLowerCase()] = vendor;
}

const outPath = new URL('../server-data/oui.json', import.meta.url).pathname;
fs.writeFileSync(outPath, JSON.stringify(oui));
console.log(`Wrote ${outPath} with ${Object.keys(oui).length} OUI entries`);
