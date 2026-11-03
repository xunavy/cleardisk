import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// 确保清除 IDE 终端可能注入的 ELECTRON_RUN_AS_NODE 环境变量
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.join(rootDir, 'dist', 'main', 'main.js'), ...process.argv.slice(2)];

const child = spawn(electronBin, args, {
  cwd: rootDir,
  env,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
