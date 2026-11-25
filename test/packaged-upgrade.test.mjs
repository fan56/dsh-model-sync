// pnpm 11 strictDepBuilds regression, see dsh-subagent-registry#10.
// pnpm 11 defaults to strictDepBuilds: an install whose dependency declares an
// unapproved preinstall/install/postinstall script exits non-zero with
// ERR_PNPM_IGNORED_BUILDS, and the dsh host plugin manager rolls the update
// back. This test reproduces the upgrade path: install the published baseline
// from the official registry, then install the locally packed tarball over it
// and assert the package carries no install hook, still ships its bundle patch
// and entry, and still leaves the consumer tree alone.
// Run: node test/packaged-upgrade.test.mjs  (after `npm run build`; needs
// network access to registry.npmjs.org for the baseline)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
// Windows needs cmd.exe to launch npm's .cmd shim; keep paths as separate arguments.
const npm = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'npm'
const npmArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd'] : []
const pkgName = '@aiwayds/dsh-model-sync'
const registry = 'https://registry.npmjs.org'
const installHooks = ['preinstall', 'install', 'postinstall']
const baselineVersion = '0.9.0'
// The packed tarball must always carry the repo manifest's version, so read it
// instead of pinning it: a release bump no longer needs a hand edit here.
const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version
const bundlePatch = './cordis.patch.yml'

if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
  throw new Error('lib/index.js missing — run `npm run build` before the test chain')
}

test('packaged upgrade: baseline install, then the packed tarball lands with no install hook', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'model-sync packaged upgrade-'))
  try {
    const consumer = join(scratch, 'consumer')
    const installedDir = join(consumer, 'node_modules', '@aiwayds', 'dsh-model-sync')
    const installedManifest = () => JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
    // A closure-linking install hook (if one ever regressed in) must fail on a
    // missing path instead of touching a real dsh closure.
    const env = { ...process.env, DSH_CLOSURE_DIR: join(scratch, 'missing-closure') }

    // 1. Baseline: the published version, pinned to the official registry so a
    //    dev mirror does not decide the fixture.
    const baseline = spawnSync(
      npm,
      [...npmArgs, 'install', `${pkgName}@${baselineVersion}`, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`],
      { cwd: scratch, encoding: 'utf8', env },
    )
    assert.equal(baseline.status, 0, `baseline ${baselineVersion} install failed:\n${baseline.stdout}\n${baseline.stderr}`)
    assert.equal(installedManifest().version, baselineVersion, `baseline fixture is ${baselineVersion}`)

    // 2. Pack the repo into a dedicated empty directory. The tarball name comes
    //    from the filesystem, never from `npm pack --json` stdout: lifecycle
    //    log lines corrupt that output on some npm versions, so scan the
    //    destination with readdirSync instead.
    const packDir = join(scratch, 'pack')
    mkdirSync(packDir)
    execFileSync(npm, [...npmArgs, 'pack', '--pack-destination', packDir], { cwd: repoRoot, encoding: 'utf8' })
    const tarballs = readdirSync(packDir).filter((f) => f.endsWith('.tgz'))
    assert.equal(tarballs.length, 1, `pack emitted exactly one tarball, got ${tarballs.join(', ') || 'none'}`)
    const tarball = join(packDir, tarballs[0])

    // 3. Tarball manifest: the install-hook gate set is empty (pnpm 11 gates
    //    exactly preinstall/install/postinstall), and the version and bundle
    //    patch match the repo manifest.
    const tarManifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }))
    assert.equal(tarManifest.version, repoVersion, `packed version is ${repoVersion}`)
    for (const key of installHooks) {
      assert.ok(!Object.hasOwn(tarManifest.scripts, key), `tarball manifest carries no ${key} script (#10)`)
    }
    assert.equal(tarManifest.dsh.bundle.patch, bundlePatch, 'bundle patch still declared')

    // 4. Upgrade in place: the plugin manager's exact step. Must exit 0 and
    //    must not produce a pnpm-11 unapproved-build report (the regression
    //    class this test pins).
    const upgrade = spawnSync(
      npm,
      [...npmArgs, 'install', tarball, '--prefix', consumer, '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`],
      { cwd: scratch, encoding: 'utf8', env },
    )
    const output = `${upgrade.stdout ?? ''}\n${upgrade.stderr ?? ''}`
    assert.equal(upgrade.status, 0, `upgrade to the packed ${repoVersion} failed:\n${output}`)
    assert.ok(
      !/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(output),
      `upgrade output carries a pnpm-11 unapproved-build report:\n${output}`,
    )

    const upgraded = installedManifest()
    assert.equal(upgraded.version, repoVersion, `upgrade landed ${repoVersion}`)
    for (const key of installHooks) {
      assert.ok(!Object.hasOwn(upgraded.scripts, key), `installed manifest carries no ${key} script (#10)`)
    }
    assert.ok(existsSync(join(installedDir, 'cordis.patch.yml')), 'bundle patch ships')
    assert.ok(existsSync(join(installedDir, 'lib', 'index.js')), 'plugin entry ships')

    // 5. Consumer safety: no @deepseek-ai copy nested inside the installed
    //    package tree or at the consumer top level (the optional host SDK
    //    peers must stay uninstalled).
    assert.ok(
      !existsSync(join(installedDir, 'node_modules', '@deepseek-ai')),
      'no nested @deepseek-ai directory in the consumer tree',
    )
    assert.ok(
      !existsSync(join(consumer, 'node_modules', '@deepseek-ai')),
      'no top-level @deepseek-ai directory in the consumer tree',
    )
    console.log(`packaged-upgrade: ${baselineVersion} baseline → packed ${repoVersion} installs cleanly with no install hook`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
