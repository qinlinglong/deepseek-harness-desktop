import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const svgPath = resolve(here, '..', 'build', 'icon.svg')
const outPath = resolve(here, '..', 'build', 'icon.png')

await sharp(readFileSync(svgPath)).resize(1024, 1024).png().toFile(outPath)
console.log('wrote', outPath)
