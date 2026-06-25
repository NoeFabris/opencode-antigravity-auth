import { existsSync } from "node:fs"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const distDir = path.join(repoRoot, "dist")

const importPatterns = [
  /(from\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
  /(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
  /(\bimport\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
]

function hasExtension(specifier) {
  return path.posix.extname(specifier) !== ""
}

function resolveSpecifier(filePath, specifier) {
  if (hasExtension(specifier)) return specifier

  const targetPath = path.resolve(path.dirname(filePath), specifier)
  if (existsSync(`${targetPath}.js`)) return `${specifier}.js`
  if (existsSync(path.join(targetPath, "index.js"))) return `${specifier}/index.js`
  return specifier
}

async function listJsFiles(dir) {
  const entries = await readdir(dir)
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(dir, entry)
    const entryStat = await stat(entryPath)
    if (entryStat.isDirectory()) {
      files.push(...await listJsFiles(entryPath))
    } else if (entry.endsWith(".js")) {
      files.push(entryPath)
    }
  }

  return files
}

async function fixFile(filePath) {
  const source = await readFile(filePath, "utf8")
  let output = source

  for (const pattern of importPatterns) {
    output = output.replace(pattern, (match, prefix, specifier, suffix) => {
      return `${prefix}${resolveSpecifier(filePath, specifier)}${suffix}`
    })
  }

  if (output !== source) {
    await writeFile(filePath, output)
    return true
  }

  return false
}

async function main() {
  if (!existsSync(distDir)) return

  const files = await listJsFiles(distDir)
  let changed = 0

  for (const file of files) {
    if (await fixFile(file)) changed += 1
  }

  console.log(`Fixed ESM import specifiers in ${changed} dist file(s)`)
}

await main()
