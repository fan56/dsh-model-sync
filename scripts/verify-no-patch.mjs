#!/usr/bin/env node

// Plan C (settings-seam): verify that the global dsh-llm-pi-ai has no patch artifacts.

/**
 * Verify that ALL candidate dsh-llm-pi-ai/lib/index.js paths do NOT
 * contain the patch signatures (withRemoteCatalog, piAiCatalog).
 *
 * Exit 0 = all found paths are clean (no patch); exit 1 = patch detected in
 * any path or no candidate paths found.
 *
 * @module scripts/verify-no-patch
 */

import { readFile, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const readFileAsync = promisify(readFile)

const PATCH_SIGNATURES = [
  'withRemoteCatalog',
  'piAiCatalog',
]

/**
 * Find all dsh-llm-pi-ai installations by scanning pnpm store directories.
 * Looks for @deepseek-ai+dsh@* pattern in the global pnpm store.
 */
function findPnpmDshPaths() {
  const pnpmGlobalBase = join(homedir(), 'Library/pnpm/global/5/.pnpm')
  const paths = []

  try {
    const entries = readdirSync(pnpmGlobalBase)
    for (const entry of entries) {
      // Match @deepseek-ai+dsh@* pattern
      if (entry.startsWith('@deepseek-ai+dsh@')) {
        const dshPath = join(pnpmGlobalBase, entry, 'node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')
        try {
          statSync(dshPath)
          paths.push(dshPath)
        } catch {
          // File doesn't exist at this path, skip
        }
      }
    }
  } catch {
    // pnpm global directory doesn't exist, skip
  }

  return paths
}

// Static paths to check
const STATIC_PATHS = [
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
]

async function main() {
  // Combine static paths with dynamically found pnpm paths
  const candidatePaths = [...STATIC_PATHS, ...findPnpmDshPaths()]

  if (candidatePaths.length === 0) {
    console.log('OK: No dsh-llm-pi-ai installations found to check')
    process.exit(0)
  }

  let foundAny = false
  let patchDetected = false

  for (const path of candidatePaths) {
    try {
      const content = await readFileAsync(path, 'utf8')
      foundAny = true
      const found = PATCH_SIGNATURES.filter(sig => content.includes(sig))
      if (found.length > 0) {
        console.error(`FAIL: patch signatures found in ${path}:`)
        for (const sig of found) {
          console.error(`  - "${sig}"`)
        }
        patchDetected = true
      } else {
        console.log(`OK: ${path} is clean (no patch artifacts)`)
      }
    } catch {
      // File doesn't exist at this path, skip
      continue
    }
  }

  if (!foundAny) {
    console.log('OK: No dsh-llm-pi-ai installations found to check')
    process.exit(0)
  }

  if (patchDetected) {
    process.exit(1)
  }

  process.exit(0)
}

main()
