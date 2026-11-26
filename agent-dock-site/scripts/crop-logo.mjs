// Split the pixel logo (kitten + wordmark, viewBox 0 0 312 67) into two lean SVGs.
// Every sub-path in the source is an axis-aligned block: "M{x} {y}h{w}v{h}h-{w}z"
// (1px runs for the kitten, 4px blocks for the wordmark), so we can keep or drop
// blocks by their x range and re-base them without any SVG parser. The output
// viewBox is the tight bounding box of the kept blocks.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brand = resolve(root, 'public/brand');

function crop(svg, { minX, maxX }) {
  const groups = [];
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const re = /<path fill="(#[0-9a-f]{3,8})" d="([^"]+)"\/>/gi;
  let m;
  while ((m = re.exec(svg))) {
    const blocks = (m[2].match(/M\d+ \d+h\d+v\d+h-\d+z/g) || [])
      .map(run => run.match(/M(\d+) (\d+)h(\d+)v(\d+)/).slice(1).map(Number))
      .filter(([x, , w]) => x >= minX && x + w <= maxX);
    for (const [x, y, w, h] of blocks) {
      box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x + w); box.y1 = Math.max(box.y1, y + h);
    }
    if (blocks.length) groups.push({ fill: m[1], blocks });
  }
  const paths = groups
    .map(({ fill, blocks }) => `<path fill="${fill}" d="${blocks.map(([x, y, w, h]) => `M${x - box.x0} ${y - box.y0}h${w}v${h}h-${w}z`).join('')}"/>`)
    .join('');
  const width = box.x1 - box.x0;
  const height = box.y1 - box.y0;
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${paths}</svg>\n`, width, height };
}

for (const theme of ['light', 'dark']) {
  const source = readFileSync(resolve(brand, `agentdock-logo-${theme}.svg`), 'utf8');
  const wordmark = crop(source, { minX: 70, maxX: 312 });
  writeFileSync(resolve(brand, `wordmark-${theme}.svg`), wordmark.svg);
  console.log(`wordmark-${theme}.svg ${wordmark.width}x${wordmark.height}`);
  if (theme === 'light') {
    const kitten = crop(source, { minX: 0, maxX: 70 });
    writeFileSync(resolve(brand, 'kitten-mark.svg'), kitten.svg);
    console.log(`kitten-mark.svg ${kitten.width}x${kitten.height}`);
  }
}
