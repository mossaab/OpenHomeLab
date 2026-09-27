import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');

function svgScaled(svg) {
  return svg.replace('<svg', '<svg width="100%" height="100%" preserveAspectRatio="xMidYMid meet"');
}

async function shoot(browser, svgFile, size, outName) {
  const svg = svgScaled(fs.readFileSync(path.join(root, svgFile), 'utf8'));
  const page = await browser.newPage({viewport: {width: size, height: size}, deviceScaleFactor: 1});
  await page.setContent(
    `<body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg}</div>`
  );
  await page.locator('body > div').screenshot({path: path.join(pub, outName), omitBackground: true});
  await page.close();
  console.log(`rendered ${outName} (${size}x${size})`);
}

const browser = await chromium.launch();
await shoot(browser, 'public/logo.svg', 32, 'favicon-32.png');
await shoot(browser, 'public/logo.svg', 16, 'favicon-16.png');
await shoot(browser, 'scripts/logo-fullbleed.svg', 180, 'apple-touch-icon.png');
await shoot(browser, 'scripts/logo-fullbleed.svg', 192, 'icon-192.png');
await shoot(browser, 'scripts/logo-fullbleed.svg', 512, 'icon-512.png');
await browser.close();
