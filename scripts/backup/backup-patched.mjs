#!/usr/bin/env node

// Plan C (settings-seam): backup the patched dsh-llm-pi-ai/lib/index.js.

/**
 * Backup the current (patched) dsh-llm-pi-ai/lib/index.js to the backups/ directory.
 * Design doc §7.2 step 1.
 *
 * @module scripts/backup/backup-patched
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = join(homedir(), '.dsh')
const BACKUP_DIR = join(homedir(), 'github/dsh-model-sync/backups')

const CANDIDATE_PATHS = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  join(homedir(), 'Library/pnpm/global/5/.pnpm/@deepseek-ai+dsh@0.1.0-rc.6/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),
]

async function main() {
  for (const sourcePath of CANDIDATE_PATHS) {
    try {
      const content = await readFile(sourcePath, 'utf8')

      // Detect dsh version from path or package.json
      let version = 'unknown'
      try {
        const pkgPath = sourcePath.replace(/lib\/index\.js$/, 'package.json')
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        version = pkg.version ?? 'unknown'
      } catch {
        // ignore
      }

      await mkdir(BACKUP_DIR, { recursive: true })
      const backupName = `dsh-llm-pi-ai-${version}-patched.js`
      const backupPath = join(BACKUP_DIR, backupName)

      await writeFile(backupPath, content)
      console.log(`Backup created: ${backupPath}`)
      console.log(`  Source: ${sourcePath}`)
      console.log(`  Size: ${content.length} bytes`)
      process.exit(0)
    } catch {
      continue
    }
  }

  console.error('ERROR: could not find dsh-llm-pi-ai/lib/index.js at any known path')
  process.exit(1)
}

main()
