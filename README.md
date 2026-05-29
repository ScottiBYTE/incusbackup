cd ~/incusbackup
cp README.md README.md.before-cleanup

python3 <<'PY'
from pathlib import Path

p = Path("README.md")
s = p.read_text()

s = s.replace(
"""# Current Release

**Latest Version:** v1.0.0

### Highlights

## Highlights
""",
"""# Current Release

**Latest Version:** [v1.0.0](../../releases/tag/v1.0.0)

## Highlights
"""
)

s = s.replace(
"Incus containers and incus virtual machines",
"Incus containers and virtual machines"
)

s = s.replace(
"- One-click backup exports",
"- One-click backups"
)

s = s.replace
