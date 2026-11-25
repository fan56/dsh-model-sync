# ADR 0001: In-command single confirmation for `/model-sync migrate-go`

- **Status:** Accepted
- **Date:** 2026-11-25
- **Implemented in:** `9adf9f5` (branch `feat/migrate-go-one-shot`; baseline `90dd1d2` = v0.10.0)

## Context

`migrate plan` / `migrate apply` is the only path that rewrites a profile's handwritten opencode-go model lists into the managed routes, and it sits behind a deliberate triple explicit-consent gate:

1. **`planHash`** — sha256 of the canonical plan body; consent binds to the exact plan, so any edit to it invalidates the hash (`planHashOf` / `verifyConsent` in `src/opencode-go-migrate.ts`).
2. **A 6-digit `confirmCode`** deterministically derived from the planHash (`confirmCodeOf`) — a second, human-transcribed token.
3. **`--ack-managed`** — an explicit acknowledgement that the routes become plugin-managed (the fixed informed-consent text is hashed into the plan body).

The design goal was informedness: the user must have seen the per-id action table and must hand-carry proof of that reading into the apply invocation. Consent has no bypass anywhere — `--yes`/`--auto` are recognised and rejected explicitly (`src/index.ts:1214-1217` at `9adf9f5`), and `applyMigration` refuses unless both tokens match (`verifyConsent` → `plan-hash-mismatch` / `confirm-code-mismatch`).

The cost: to migrate one profile the user copies two derived tokens (planHash, confirmCode) from the plan output into a manual `migrate apply --plan <hash> --confirm <code> --ack-managed` invocation — a minimum of two commands per profile, commonly three to five once a missed flag or a typo forces a retry, repeated for every additional profile. The tokens carry no information the user acts on; they only prove the plan output was once on screen.

## Decision

Add `/model-sync migrate-go`: one command runs plan → file backups → ONE confirmation → apply, per profile.

- **One `ctx.userQuestions` confirmation for the whole run.** The question names the legacy stubs to be replaced, the slots being created, a per-profile add/delete/keep summary, and the backup paths; the options are 执行迁移 / 取消.
- **The consent triple is still required and still verified by the unchanged gate.** `planHash` and `confirmCode` are computed caller-side from the SAME plan the confirmation just presented and passed into `applyMigration` (with `ackManaged: true`); `verifyConsent` is untouched. The user stops hand-carrying tokens; the informedness moves into the question text.
- **`--ack-managed` semantics are preserved, not removed** — acknowledgement stays mandatory, it just stops being a manual carry ("not cancelling informedness, cancelling the carrying").
- **`--yes`/`--auto` remain rejected**: `parseMigrateGoFlags` treats them as unknown flags carrying the usage text ("consent comes from the interactive confirmation").
- **Without the ask channel, or on any ask error, the command fails closed** and prints the manual `migrate plan`/`apply` path together with the computed hashes — never a write.

## Alternatives considered

- **Remove the consent gate entirely.** Rejected: loses both the informedness property and the misfire protection of the only writer that can delete or rewrite handwritten model lists.
- **A thin wrapper that still requires manual tokens.** Rejected: it saves typing one command, but copying two opaque tokens per profile was the actual pain point, so the friction would remain.
- **Keep the three gates but compress them into one interactive question (chosen).** Consent strength is preserved — gate code untouched, plan-bound hash, mandatory acknowledgement — while the mechanical token carrying disappears.

## Consequences

Positive:

- One command per run; `--all-profiles` covers every stub-bearing profile behind a single confirmation.
- Backups precede any write (`cordis.patch.yml.bak.<YYYYMMDD-HHMMSS>` per profile, plus one `models-store.json.bak.<same-stamp>` per run; 3 newest kept per category by filename timestamp) and are plain inspectable files.
- Any apply failure stops the batch and byte-restores every file the run changed; a models-store created by the run is removed again.

Negative / risks:

- The "human has read the table" step is no longer enforced through token transcription; it becomes auditable after the fact via the run log (`~/.dsh/storages/dsh-model-sync/migrate-go-<stamp>.log`), which records the confirmation outcome and every apply line. The narrow window between planning and apply — a user edit landing in between — is now covered by the backup + byte-restore safety net instead of the token handshake (this window is a documented limitation of `migrate apply` itself; see CHANGELOG 0.10.0 Known limitations §1).
- The in-command confirmation depends on the host `userQuestions` channel. Hosts without it fail closed to the manual flow — the feature is unavailable there by design, and no headless bypass exists.
- Cancel is zero-write for config, but the backups created before the question stay on disk (by design; the cancel report names them).

## Verification

`test/opencode-go-one-shot.test.mjs` (25 checks, all passing at `9adf9f5`) covers, among others:

- **Cancel → zero writes**: settings and patch untouched, backups stay, models-store never created;
- **No channel / ask error → fail-closed**: missing `userQuestions` and a throwing ask both return the manual path with the computed planHash/confirmCode and zero config writes;
- **Mid-apply failure → byte restore**: every file the run changed is restored byte-for-byte from the run's backups, no ledger residue;
- **Backup retention keeps exactly the 3 newest** matching files per category;
- **`--all-profiles` migrates every stub profile behind ONE confirmation**;
- **`--yes`/`--auto` are unknown flags** at both the parser and the command surface.

## Revocation path

migrate-go introduces no new persistent format — its only on-disk additions are the `.bak` files and the per-run log. Removing the `migrate-go` dispatch branch (`src/index.ts`), the one-shot module (`src/opencode-go-one-shot.ts`), and the patch-file editor (`src/opencode-go-patch-file.ts`) — plus their tests — returns the repo to the pure plan/apply flow with **no data migration**: existing backups, journals, and models-store entries keep their exact meaning under `migrate` unchanged.
