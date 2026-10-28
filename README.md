# twitch-sim — private dev notes (local-only branch `notes`)

This is a linked worktree of the `notes` branch, checked out at `twitch-sim/notes/`
and gitignored by `master`. It holds the plans, ledgers, unit specs and run reports
that used to sit in the public repo. The branch is backed up to the NAS by
`backup-all.sh` (`push --all`) and must NEVER be pushed to GitHub (`origin`).

- `PLAN.md` — the original plan + ledger
- `PLAN-CHAT-V2.md` — chat v2 ("the regulars") plan
- `PLAN-RELEASE.md` — the 2026-10-28 public-release review + fix plan
- `tasks/` — unit specs, fleet handoff manifest, run reports
- `tasks/phone-lane/` — reports from the retired `phone-smolvlm` lane
