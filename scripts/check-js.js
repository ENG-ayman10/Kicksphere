const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignoredDirs = new Set([
  '.git',
  'node_modules',
  'logs',
  'uploads'
]);

const files = [];

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        walk(path.join(dir, entry.name));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.join(dir, entry.name));
    }
  }
};

walk(root);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
