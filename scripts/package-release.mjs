import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

const root = process.cwd();
const dist = path.join(root, 'dist');
const release = path.join(root, 'release');
const outputPath = path.join(release, 'OpenCode-edge-extension.zip');
if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error('dist/manifest.json is missing; build the extension first.');
fs.mkdirSync(release, { recursive: true });
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', resolve); output.on('error', reject); archive.on('error', reject);
  archive.pipe(output); archive.directory(dist, false); void archive.finalize();
});
console.log(`Created ${path.relative(root, outputPath)} (${fs.statSync(outputPath).size} bytes).`);
