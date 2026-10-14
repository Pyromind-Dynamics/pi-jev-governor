// Regenerates the SVG-based PNG figures in docs/assets/ from the SVG sources
// in this directory (the results card and the workflow diagram are external
// designs and have no SVG source here).
//
//   npm install @resvg/resvg-js
//   node render.mjs cost-en.svg ../math500-cost-change-en.png 3080
//   sips -Z 1760 ../math500-cost-change-en.png    # downscale for the repo
//
// The README displays the figures at width=860/1000, so keep the longest edge
// >= 1720px for HiDPI. System fonts are loaded (Helvetica Neue for the
// English figures, PingFang SC for the Chinese ones).
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , infile, outfile, widthArg] = process.argv;
const width = Number(widthArg || 3080);
const svg = readFileSync(infile, 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: width },
  font: { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' },
  background: 'white',
});
const img = resvg.render();
writeFileSync(outfile, img.asPng());
console.log(outfile, `${img.width}x${img.height}`, img.asPng().length, 'bytes');
