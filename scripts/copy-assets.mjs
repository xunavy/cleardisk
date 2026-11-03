import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const srcRenderer = path.join(rootDir, 'src', 'renderer');
const distRenderer = path.join(rootDir, 'dist', 'renderer');

fs.mkdirSync(distRenderer, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(srcRenderer, file), path.join(distRenderer, file));
}

// 移除 tsc 生成在 dist/renderer/app.js 中的 CommonJS Object.defineProperty(exports, ...) 语句，使其可直接在浏览器 script 标签运行
const appJsPath = path.join(distRenderer, 'app.js');
if (fs.existsSync(appJsPath)) {
  let content = fs.readFileSync(appJsPath, 'utf-8');
  content = content.replace(/Object\.defineProperty\(exports,\s*"__esModule",\s*\{\s*value:\s*true\s*\}\);?/g, '');
  fs.writeFileSync(appJsPath, content, 'utf-8');
}

console.log('Renderer assets copied to dist/renderer/');
