#!/usr/bin/env node

// Plan C (settings-seam): generate builtin catalog snapshot.

/**
 * Generate src/builtin-catalog-snapshot.ts from the installed
 * @deepseek-ai/dsh-llm-pi-ai catalog data.
 *
 * Two modes:
 * - --check (CI): compare installed catalog with snapshot, exit 1 if different
 * - --generate (dev): regenerate snapshot from installed catalog
 *
 * @module scripts/generate-builtin-snapshot
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

const PROJECT_ROOT = join(homedir(), 'github/dsh-model-sync')
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'src/builtin-catalog-snapshot.ts')

const isCheckMode = process.argv.includes('--check')
const isGenerateMode = process.argv.includes('--generate')

if (!isCheckMode && !isGenerateMode) {
  console.error('Usage: node scripts/generate-builtin-snapshot.mjs [--check|--generate]')
  console.error('  --check     CI mode: compare installed catalog with snapshot')
  console.error('  --generate  Dev mode: regenerate snapshot from installed catalog')
  process.exit(1)
}

/**
 * Load builtin catalog data from the installed pi-ai package.
 * Reads the JSON data files directly since they contain the raw model definitions.
 */
async function loadInstalledCatalog() {
  // The data files are at: @earendil-works/pi-ai/dist/providers/data/*.json
  const piAiBase = '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data'

  // Routes we care about (matching DEFAULT_ROUTES in index.ts)
  const routes = ['opencode-go', 'zai-coding-cn', 'minimax-cn', 'xiaomi-token-plan-cn']

  const catalog = {}

  for (const route of routes) {
    try {
      const dataPath = join(piAiBase, `${route}.json`)
      const rawData = JSON.parse(await readFile(dataPath, 'utf8'))

      // Flatten the nested structure: { api: { modelId: { id, api, maxTokens, ... } } }
      const models = []
      for (const [api, apiModels] of Object.entries(rawData)) {
        if (typeof apiModels === 'object' && apiModels !== null) {
          for (const [modelId, modelData] of Object.entries(apiModels)) {
            if (typeof modelData === 'object' && modelData !== null && 'id' in modelData) {
              models.push({
                id: modelData.id,
                api: modelData.api ?? api,
                maxTokens: modelData.maxTokens,
              })
            }
          }
        }
      }

      // Sort by id for consistent comparison
      models.sort((a, b) => a.id.localeCompare(b.id))
      catalog[route] = models
    } catch (err) {
      console.error(`WARNING: Could not read catalog for route ${route}: ${err.message}`)
      catalog[route] = []
    }
  }

  return catalog
}

/**
 * Parse the existing snapshot file to extract the catalog data.
 */
async function parseExistingSnapshot() {
  const content = await readFile(SNAPSHOT_PATH, 'utf8')

  // Extract the BUILTIN_CATALOG_SNAPSHOT object using regex
  // This is a simplified parser - in production you'd use a proper AST parser
  const match = content.match(/export const BUILTIN_CATALOG_SNAPSHOT:\s*BuiltinCatalogSnapshotMap\s*=\s*(\{[\s\S]*?\n\})/m)
  if (!match) {
    throw new Error('Could not parse existing snapshot file')
  }

  // Use Function constructor to evaluate the object literal
  // This is safe since we control the snapshot file
  const objStr = match[1]
  const fn = new Function(`return ${objStr}`)
  return fn()
}

/**
 * Generate the TypeScript snapshot file content.
 */
function generateSnapshotContent(catalog) {
  const lines = [
    '// Plan C (settings-seam): builtin catalog snapshot — single source of truth.',
    '',
    '/**',
    ' * Builtin catalog snapshot for base-matching classification and maxTokens',
    ' * stripping (design doc §3.6).',
    ' *',
    ' * This module is the single source of truth for the hardcoded builtin catalog',
    ' * data used by index.ts, translate.test.mjs, and serviceability.test.mjs.',
    ' *',
    ' * To regenerate: run `node scripts/generate-builtin-snapshot.mjs --generate`',
    ' *',
    ' * @module dsh-model-sync/builtin-catalog-snapshot',
    ' */',
    '',
    "import type { BuiltinModelData } from './translate.ts'",
    '',
    '/** Per-route builtin catalog snapshot. */',
    'export interface BuiltinCatalogSnapshotMap {',
    '  [route: string]: BuiltinModelData[]',
    '}',
    '',
    '/** Builtin catalog data keyed by route id. */',
    'export const BUILTIN_CATALOG_SNAPSHOT: BuiltinCatalogSnapshotMap = {',
  ]

  const routes = Object.keys(catalog).sort()
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i]
    const models = catalog[route]
    const isLast = i === routes.length - 1

    lines.push(`  '${route}': [`)

    for (let j = 0; j < models.length; j++) {
      const model = models[j]
      const isLastModel = j === models.length - 1
      const maxTokensStr = model.maxTokens !== undefined ? `, maxTokens: ${model.maxTokens}` : ''
      lines.push(`    { id: '${model.id}', api: '${model.api}'${maxTokensStr} }${isLastModel ? '' : ','}`)
    }

    lines.push(`  ]${isLast ? '' : ','}`)
  }

  lines.push('}')
  lines.push('')

  return lines.join('\n')
}

/**
 * Compare two catalog snapshots and return differences.
 */
function compareCatalogs(installed, existing) {
  const diffs = []

  const allRoutes = new Set([...Object.keys(installed), ...Object.keys(existing)])

  for (const route of allRoutes) {
    const installedModels = installed[route] ?? []
    const existingModels = existing[route] ?? []

    const installedIds = new Set(installedModels.map(m => m.id))
    const existingIds = new Set(existingModels.map(m => m.id))

    // Check for missing/extra model ids
    const missingInExisting = [...installedIds].filter(id => !existingIds.has(id))
    const extraInExisting = [...existingIds].filter(id => !installedIds.has(id))

    if (missingInExisting.length > 0 || extraInExisting.length > 0) {
      diffs.push({
        route,
        type: 'model-ids',
        missingInExisting,
        extraInExisting,
      })
    }

    // Check for api/maxTokens differences in shared models
    const installedMap = new Map(installedModels.map(m => [m.id, m]))
    const existingMap = new Map(existingModels.map(m => [m.id, m]))

    for (const [id, installedModel] of installedMap) {
      const existingModel = existingMap.get(id)
      if (!existingModel) continue

      const fieldDiffs = []
      if (installedModel.api !== existingModel.api) {
        fieldDiffs.push(`api: ${existingModel.api} -> ${installedModel.api}`)
      }
      if (installedModel.maxTokens !== existingModel.maxTokens) {
        fieldDiffs.push(`maxTokens: ${existingModel.maxTokens} -> ${installedModel.maxTokens}`)
      }

      if (fieldDiffs.length > 0) {
        diffs.push({
          route,
          type: 'field-diff',
          modelId: id,
          changes: fieldDiffs,
        })
      }
    }
  }

  return diffs
}

async function main() {
  console.log('Loading installed catalog...')
  const installed = await loadInstalledCatalog()

  if (isCheckMode) {
    console.log('Checking snapshot against installed catalog...')
    const existing = await parseExistingSnapshot()
    const diffs = compareCatalogs(installed, existing)

    if (diffs.length === 0) {
      console.log('OK: Snapshot matches installed catalog')
      process.exit(0)
    }

    console.error('FAIL: Snapshot differs from installed catalog:')
    for (const diff of diffs) {
      if (diff.type === 'model-ids') {
        if (diff.missingInExisting.length > 0) {
          console.error(`  ${diff.route}: missing in snapshot: ${diff.missingInExisting.join(', ')}`)
        }
        if (diff.extraInExisting.length > 0) {
          console.error(`  ${diff.route}: extra in snapshot: ${diff.extraInExisting.join(', ')}`)
        }
      } else if (diff.type === 'field-diff') {
        console.error(`  ${diff.route}/${diff.modelId}: ${diff.changes.join('; ')}`)
      }
    }
    console.error('')
    console.error('Run: node scripts/generate-builtin-snapshot.mjs --generate')
    process.exit(1)
  }

  if (isGenerateMode) {
    console.log('Generating snapshot...')
    const content = generateSnapshotContent(installed)
    await writeFile(SNAPSHOT_PATH, content, 'utf8')
    console.log(`Wrote snapshot to ${SNAPSHOT_PATH}`)
    console.log('Routes:', Object.keys(installed).sort().join(', '))
    console.log('Total models:', Object.values(installed).reduce((sum, m) => sum + m.length, 0))
    process.exit(0)
  }
}

main().catch(err => {
  console.error('ERROR:', err.message)
  process.exit(1)
})
