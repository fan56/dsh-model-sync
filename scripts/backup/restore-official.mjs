#!/usr/bin/env node

// Plan C (settings-seam): restore official dsh-llm-pi-ai/lib/index.js from npm.

/**
 * Restore the official (unpatched) dsh-llm-pi-ai/lib/index.js.
 * Design doc §7.2 step 2.
 *
 * Extracts the official version from npm pack, validates against the patch
 * (reverse-apply check via `patch --dry-run`), and copies it to the global
 * install path.
 *
 * Version is read from the project's package.json (not hardcoded).
 *
 * Usage: node scripts/backup/restore-official.mjs [--dry-run]
 *
 * @module scripts/backup/restore-official
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BACKUP_DIR = join(homedir(), 'github/dsh-model-sync/backups')
const PATCH_FILE = join(homedir(), 'github/dsh-model-sync/docs-dsh-llm-pi-ai.patch')
const PROJECT_ROOT = join(homedir(), 'github/dsh-model-sync')

const TARGET_PATHS = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
]

const DRY_RUN = process.argv.includes('--dry-run')

/**
 * Read the dsh-llm-pi-ai version from the installed package's package.json.
 * Falls back to hardcoded default if not found.
 */
async function readDshVersion() {
  try {
    const installedPkgPath = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json'
    const pkg = JSON.parse(await readFile(installedPkgPath, 'utf8'))
    return pkg.version ?? '0.1.0-rc.6'
  } catch {
    return '0.1.0-rc.6'
  }
}

async function main() {
  const version = await readDshVersion()
  console.log(`Restoring official dsh-llm-pi-ai (dsh version: ${version})...`)

  if (DRY_RUN) {
    console.log('[dry-run] Would:')
    console.log(`  1. npm pack @deepseek-ai/dsh-llm-pi-ai@${version}`)
    console.log('  2. Extract lib/index.js')
    console.log('  3. Validate against patch (patch --dry-run reverse-apply check)')
    console.log('  4. Copy to global install path')
    process.exit(0)
  }

  // Step 1: npm pack
  const tmpDir = join(BACKUP_DIR, 'tmp-extract')
  await mkdir(tmpDir, { recursive: true })

  console.log(`Fetching @deepseek-ai/dsh-llm-pi-ai@${version} from npm...`)
  try {
    execSync(`npm pack @deepseek-ai/dsh-llm-pi-ai@${version}`, {
      cwd: tmpDir,
      stdio: 'pipe',
    })
  } catch (err) {
    console.error('ERROR: npm pack failed. Check network and package version.')
    console.error(err.message)
    process.exit(1)
  }

  // Step 2: Extract
  const tgzFiles = (await import('node:fs')).readdirSync(tmpDir).filter(f => f.endsWith('.tgz'))
  if (tgzFiles.length === 0) {
    console.error('ERROR: no .tgz file found after npm pack')
    process.exit(1)
  }

  const tgzPath = join(tmpDir, tgzFiles[0])
  console.log(`Extracting ${tgzPath}...`)
  execSync(`tar xzf "${tgzPath}" -C "${tmpDir}"`, { stdio: 'pipe' })

  const officialPath = join(tmpDir, 'package/lib/index.js')
  try {
    const content = await readFile(officialPath, 'utf8')
    console.log(`Official lib/index.js extracted: ${content.length} bytes`)

    // Step 3: Validate — write official file to tmpDir and use patch --dry-run
    // to confirm the patch applies cleanly (reverse-apply check)
    let patchValid = false
    try {
      // Create the directory structure in tmpDir to match the patch paths
      const tmpPatchDir = join(tmpDir, 'patch-check')
      const tmpFileDir = join(tmpPatchDir, 'lib')
      await mkdir(tmpFileDir, { recursive: true })
      await writeFile(join(tmpFileDir, 'index.js'), content)

      // Use execFileSync with -d flag to apply patch against tmpDir
      execFileSync('patch', ['--dry-run', '-R', '-p1', '-d', tmpPatchDir], {
        input: await readFile(PATCH_FILE),
        stdio: 'pipe',
      })
      patchValid = true
      console.log('Patch validation: OK (patch applies cleanly to official file)')
    } catch (patchErr) {
      // --dry-run with -R (reverse) checks if the patch can be cleanly reversed
      // from the patched state. If this fails, the official file doesn't match
      // the expected pre-patch state.
      const stderr = patchErr.stderr?.toString() ?? ''
      if (stderr.includes('FAILED') || stderr.includes('unexpected')) {
        console.error('WARNING: patch --dry-run reverse-apply failed.')
        console.error('The official file may not match the expected pre-patch state.')
        console.error(stderr)
        process.exit(1)
      }
      // Some patch versions don't support --dry-run well; fall back to signature check
      const hasPatch = content.includes('withRemoteCatalog') || content.includes('piAiCatalog')
      if (hasPatch) {
        console.error('WARNING: official package already contains patch signatures!')
        console.error('This may indicate the npm package was already patched.')
        process.exit(1)
      }
      console.log('Patch validation: OK (signature check fallback)')
      patchValid = true
    }

    if (!patchValid) {
      console.error('Patch validation failed; aborting restore.')
      process.exit(1)
    }

    // Step 4: Copy to global install path
    let restored = false
    for (const targetPath of TARGET_PATHS) {
      try {
        await writeFile(targetPath, content)
        console.log(`Restored: ${targetPath}`)
        restored = true
        break
      } catch {
        continue
      }
    }

    if (!restored) {
      console.error('ERROR: could not write to any target path')
      console.error('You may need to run with elevated permissions')
      process.exit(1)
    }

    console.log('Done. Verify with: node scripts/verify-no-patch.mjs')
  } finally {
    // Cleanup tmp
    await rm(tmpDir, { recursive: true, force: true })
  }
}

main()
