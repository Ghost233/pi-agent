@/Users/admin/.codex/RTK.md
@/Users/admin/.codex/CavemanClaude.md

# Repository Instructions

- Before every `git commit` in this repository, switch GitHub CLI auth to the
  `Ghost233` account:

  ```bash
  rtk gh auth switch --hostname github.com --user Ghost233
  ```

- If the active GitHub CLI account is unclear, verify it before committing:

  ```bash
  rtk gh auth status --hostname github.com
  ```

- Commits must use this Git identity for both author and committer:

  ```bash
  git config user.name "Ghost233"
  git config user.email "only.yesc@gmail.com"
  ```

- This repository uses `.githooks/pre-commit` to block commits with any other
  Git identity. Keep this enabled with:

  ```bash
  git config core.hooksPath .githooks
  ```
