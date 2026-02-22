import * as fs from 'fs';
import * as path from 'path';

const ROOT_DIR = path.join(import.meta.dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DEPS_TO_FIX = [
  path.join(ROOT_DIR, 'node_modules', '@opencode-ai', 'plugin', 'dist'),
];

const IMPORT_PATTERN = /from\s+["'](\.\.?\/[^"']+)["']/g;

function fixImport(importPath: string, currentFile: string): string {
  if (importPath.endsWith('.js')) {
    return importPath;
  }

  const currentDir = path.dirname(currentFile);
  const resolvedPath = path.resolve(currentDir, importPath);
  
  if (fs.existsSync(resolvedPath + '.js')) {
    return `${importPath}.js`;
  }
  
  const indexPath = path.join(resolvedPath, 'index.js');
  if (fs.existsSync(indexPath)) {
    return `${importPath}/index.js`;
  }

  return `${importPath}.js`;
}

function fixFile(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  const newContent = content.replace(IMPORT_PATTERN, (match, importPath) => {
    const fixed = fixImport(importPath, filePath);
    if (fixed !== importPath) {
      modified = true;
      return `from "${fixed}"`;
    }
    return match;
  });

  if (modified) {
    fs.writeFileSync(filePath, newContent);
    console.log(`Fixed: ${filePath}`);
  }

  return modified;
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

function fixDirectory(dir: string, label: string): number {
  if (!fs.existsSync(dir)) {
    console.log(`Skipping ${label} (not found)`);
    return 0;
  }

  console.log(`\nFixing ${label}...`);
  const files = walkDir(dir);
  let fixedCount = 0;

  for (const file of files) {
    if (fixFile(file)) {
      fixedCount++;
    }
  }

  return fixedCount;
}

function main(): void {
  let totalFixed = 0;

  totalFixed += fixDirectory(DIST_DIR, 'dist/');
  
  for (const depDir of DEPS_TO_FIX) {
    const depName = path.relative(ROOT_DIR, depDir);
    totalFixed += fixDirectory(depDir, depName);
  }

  console.log(`\nTotal files fixed: ${totalFixed}`);
}

main();
