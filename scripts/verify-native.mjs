#!/usr/bin/env node
/**
 * Verify the freshly built package contains the native modules for the
 * CURRENT platform. Runs inside CI after electron-builder produces the
 * unpacked app (mac: the mac-* .app bundle, win: win-unpacked, linux:
 * linux-unpacked).
 *
 * Regression this guards: building Windows/Linux from macOS node_modules
 * silently produced installers missing sharp/koffi/node-pty/
 * node-addon-require-builtin platform binaries -> app crashed at boot.
 * Each platform must be built on its own OS so optional native deps are
 * present; this script fails the build if any are missing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const releaseRoot = resolve('release')
const PLATFORM = process.platform

/** Recursively collect files (native binaries) under a dir. */
function collectNativeFiles(dir, out = [], depth = 0) {
  if (depth > 8) return out
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) collectNativeFiles(p, out, depth + 1)
    else if (/\.(node|dll|dylib|so)$/.test(name) || name === 'landlock-run') out.push(p)
  }
  return out
}

/** Map process platform -> npm optional-dependency suffix. */
function platformKey() {
  if (PLATFORM === 'darwin') return `darwin-${process.arch}`
  if (PLATFORM === 'win32') return `win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  return `linux-${process.arch}`
}

/** Locate every unpacked resources dir (where natives are extracted).
 * 返回 [{ dir, key }]：mac 从目录名（mac-arm64 / mac-x64）推断架构，
 * 使双架构构建时各自验证对应架构的原生模块；win/linux 用当前平台。 */
function unpackedResourcesDirs() {
  const dirs = []
  let entries = []
  try {
    entries = readdirSync(releaseRoot)
  } catch {
    return dirs
  }
  for (const name of entries) {
    const p = join(releaseRoot, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (PLATFORM === 'darwin' && name.startsWith('mac-')) {
      const appDir = join(p, 'DeepSeek Harness.app', 'Contents', 'Resources')
      if (existsSync(appDir)) {
        const arch = name.slice(4) // 'mac-arm64' -> 'arm64', 'mac-x64' -> 'x64'
        dirs.push({ dir: appDir, key: `darwin-${arch}` })
      }
    } else if (name.endsWith('-unpacked')) {
      const resources = join(p, 'resources')
      if (existsSync(resources)) dirs.push({ dir: resources, key: platformKey() })
    }
  }
  return dirs
}

const key = platformKey()
const checks = [
  { name: 'sharp', match: (p) => p.includes(`sharp-${key}`) },
  { name: 'koffi', match: (p) => p.includes(`koffi-${key}`) },
  {
    name: 'node-pty',
    // prebuilds/<key> or build/Release/pty.node; match on substrings so it
    // works with both forward (POSIX) and backslash (Windows) separators.
    match: (p) => p.includes('node-pty') && (
      (p.includes('prebuilds') && p.includes(key)) ||
      /node-pty[\\/]build[\\/]Release[\\/]pty\.node$/.test(p)
    ),
  },
  { name: 'node-addon-require-builtin', match: (p) => p.includes(`require-builtin-${key}`) },
]
if (PLATFORM === 'linux') {
  checks.push({ name: 'landlock', match: (p) => p.includes('landlock-run-linux') })
}

const resourcesDirs = unpackedResourcesDirs()
if (resourcesDirs.length === 0) {
  console.error(`✖ no unpacked resources dir found under ${releaseRoot}`)
  process.exit(1)
}

let ok = true
for (const entry of resourcesDirs) {
  const dir = entry.dir
  const key = entry.key
  console.log(`\n=== ${dir.replace(releaseRoot + '/', '')} (key: ${key}) ===`)
  const natives = collectNativeFiles(dir)
  for (const { name, match } of checks) {
    const hit = natives.find(match)
    if (hit) {
      console.log(`  ✓ ${name}: ...${hit.split(/node_modules[\\/]/).pop()}`)
    } else {
      console.error(`  ✖ ${name}: MISSING native binary for ${key}`)
      ok = false
    }
  }
}

if (!ok) {
  console.error('\n✖ Native module verification FAILED. Build must run on the target OS.')
  process.exit(1)
}
console.log('\n✓ All native modules present for this platform.')
