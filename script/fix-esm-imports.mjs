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

const failedLookups = new Set()

function resolveSpecifier(filePath, specifier) {
  if (hasExtension(specifier)) return specifier

  const targetPath = path.resolve(path.dirname(filePath), specifier)

  const jsPath = `${targetPath}.js`
  if (!failedLookups.has(jsPath)) {
    if (existsSync(jsPath)) return `${specifier}.js`
    failedLookups.add(jsPath)
  }

  const mjsPath = `${targetPath}.mjs`
  if (!failedLookups.has(mjsPath)) {
    if (existsSync(mjsPath)) return `${specifier}.mjs`
    failedLookups.add(mjsPath)
  }

  const indexJsPath = path.join(targetPath, "index.js")
  if (!failedLookups.has(indexJsPath)) {
    if (existsSync(indexJsPath)) return `${specifier}/index.js`
    failedLookups.add(indexJsPath)
  }

  const indexMjsPath = path.join(targetPath, "index.mjs")
  if (!failedLookups.has(indexMjsPath)) {
    if (existsSync(indexMjsPath)) return `${specifier}/index.mjs`
    failedLookups.add(indexMjsPath)
  }

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
    } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
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
