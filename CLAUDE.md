# CLAUDE.md

This file documents the architecture, conventions, and workflows for the **awesome-claude-code** repository. It is intended to orient AI assistants working in this codebase.

---

## Project Overview

**awesome-claude-code** is a curated list of resources for enhancing Claude Code workflows — skills, agents, hooks, slash-commands, CLAUDE.md files, tooling, and documentation. It is maintained by the community with automated submission and review workflows powered by GitHub Actions and the Claude API.

The repository is structured around a **CSV-first data model**: all resources live in a single CSV file, and the README is fully auto-generated from it.

---

## Repository Structure

```
awesome-claude-code/
├── THE_RESOURCES_TABLE.csv       # Single source of truth for all resources
├── README.md                     # AUTO-GENERATED — never edit directly
├── README_ALTERNATIVES/          # AUTO-GENERATED — alternative README styles
├── Makefile                      # All development commands
├── pyproject.toml                # Python config, dependencies, linting
├── acc-config.yaml               # README generation style config
├── .pre-commit-config.yaml       # Git hooks (ruff, tests, readme check)
├── assets/                       # SVG badges and images
├── scripts/                      # Python automation (see below)
├── templates/                    # Jinja templates + categories.yaml
├── resources/                    # Actual resource files (CLAUDE.md examples, slash-commands)
├── docs/                         # Developer and contributor documentation
├── tests/                        # pytest test suite (22 test files)
├── tools/                        # Utilities (readme_tree updater)
├── data/                         # Data files
├── .github/                      # GitHub Actions workflows (12) + issue/PR templates
└── .claude/                      # Claude Code slash commands
    └── commands/
        └── evaluate-repository.md  # /evaluate-repository skill
```

---

## Architecture: CSV → README Pipeline

The core data flow is:

```
THE_RESOURCES_TABLE.csv
        │
        ▼
  make generate
        │
        ▼
scripts/readme/generate_readme.py
        │
        ├──▶ README.md              (root style, set in acc-config.yaml)
        └──▶ README_ALTERNATIVES/   (all other styles)
```

**CSV columns:** `ID, Display Name, Category, Sub-Category, Primary Link, Secondary Link, Author Name, Author Link, Active, Date Added, Last Modified, Last Checked, License, Description, Removed From Origin, Stale, Repo Created, Latest Release, Release Version, Release Source`

**README styles** (configured in `acc-config.yaml`): `awesome`, `extra`, `classic`, `flat`

The generator reads `templates/categories.yaml` for category metadata (names, icons, sort order, ID prefixes) and uses Jinja-style templates in `templates/`.

---

## Development Setup

Requires **Python 3.11+**.

```bash
python3 -m venv venv
source venv/bin/activate
make install          # pip install -e ".[dev]"
```

In CI, `PYTHON=python3` (no venv). Locally, `PYTHON=venv/bin/python3`.

---

## Common Commands

| Command | Purpose |
|---|---|
| `make test` | Run pytest suite |
| `make coverage` | Run tests with HTML/XML coverage reports |
| `make mypy` | Run mypy type checks |
| `make format` | Fix code with ruff (linter + formatter) |
| `make format-check` | Check formatting without fixing |
| `make ci` | Full local CI: format-check + mypy + test + docs-tree-check |
| `make generate` | Regenerate README.md + README_ALTERNATIVES/ from CSV |
| `make sort` | Sort resources in CSV by category/sub-category/name |
| `make validate` | Validate all URLs in the CSV |
| `make validate-single URL=<url>` | Validate a single URL |
| `make validate-toc` | Validate TOC anchors against GitHub HTML |
| `make test-regenerate` | Verify README generation is idempotent (requires clean tree) |
| `make test-regenerate-cycle` | Full root/style-order config change cycle test |
| `make docs-tree-check` | Verify `docs/README-GENERATION.md` file tree is current |
| `make docs-tree` | Update `docs/README-GENERATION.md` file tree |
| `make add-category` | Interactive tool to add a new category |
| `make generate-resource-id` | Interactive resource ID generator |
| `make clean` | Remove caches and test artifacts |
| `make clean-all` | Remove caches + venv |

---

## Data Conventions

### Resource IDs

Format: `{prefix}-{8-char-hex-hash}` — e.g., `skill-ca8cbc21`, `cmd-3f9a12b4`

Prefixes are defined per category in `templates/categories.yaml`:
- `skill` — Agent Skills
- `wf` — Workflows & Knowledge Guides
- `tool` — Tooling
- `status` — Status Lines
- `hook` — Hooks
- `cmd` — Slash-Commands
- `claude` — CLAUDE.md Files
- `doc` — Official Documentation

Use `make generate-resource-id` to generate a valid ID for a new resource.

### CSV Conventions

- `Active` column: `TRUE`/`FALSE` — inactive resources are excluded from the README
- `Stale` column: `TRUE`/`FALSE` — stale resources are flagged but may remain
- `Date Added` / `Last Modified` format: `YYYY-MM-DD:HH-MM-SS`
- `License`: SPDX identifier or `NOT_FOUND`, `No License / Not Specified`, `NOASSERTION`
- `Removed From Origin`: `TRUE` if the upstream resource no longer exists
- After any CSV edits, run `make sort` then `make generate`

### Category System

Categories and sub-categories are defined in `templates/categories.yaml`. This file controls display names, icons, sort order, and ID prefixes. Use `make add-category` to add new categories (do not hand-edit unless you understand the full impact on generated READMEs).

---

## Code Conventions

- **Python 3.11+** with type hints throughout
- **Ruff** for linting and formatting (line length: 100)
  - Selected rule sets: `E, W, F, I, N, UP, B, C4, SIM`
  - `scripts/archive/` is **excluded** from linting
- **mypy** for static type checking (excludes `resources/`)
- Import sorting: `known-first-party = ["scripts"]`
- `__init__.py` files may have unused imports (F401 ignored)
- Do not modify anything under `scripts/archive/` — it is legacy/archived code

---

## Testing

Tests live in `tests/` and use pytest.

```bash
make test          # Run all tests
make coverage      # Run with coverage (HTML report in htmlcov/)
make mypy          # Type checking
make ci            # Everything: format-check + mypy + test + docs-tree-check
```

Key test files:
- `tests/test_generate_readme.py` — README generation correctness
- `tests/test_validate_links.py` — Link validation logic
- `tests/test_sort_resources.py` — CSV sorting
- `tests/test_category_utils.py` — Category utilities
- `tests/test_flat_list_generator.py` — Flat-style README generation
- `tests/conftest.py` — Shared fixtures

**Regeneration test:** `make test-regenerate` deletes all generated READMEs and regenerates them, then asserts the working tree is clean. Run this before committing changes to the generation pipeline or CSV. Requires a clean git working tree.

---

## Critical Constraints

### README.md is AUTO-GENERATED
**Never edit `README.md` or `README_ALTERNATIVES/` directly.** They are fully generated by `make generate`. Any manual edits will be overwritten. If the README needs to change, update the CSV or templates, then regenerate.

### CSV is the Single Source of Truth
All resource data lives in `THE_RESOURCES_TABLE.csv`. Do not duplicate resource data elsewhere. After any CSV edit, run `make sort && make generate` and commit all changed files together.

### Submission System — Do Not Bypass
New resource submissions go through the automated GitHub Issues → PR pipeline. Do **not** manually add resources to the CSV outside of this workflow unless you are a maintainer running the approved script. The automated system handles validation, duplicate detection, cooldown enforcement, and PR creation.

### docs/README-GENERATION.md File Tree
The file tree block in `docs/README-GENERATION.md` must stay current. Run `make docs-tree` to update it, or `make docs-tree-check` to verify it. CI enforces this.

---

## Scripts Organization

```
scripts/
├── readme/           # README generation engine
│   ├── generate_readme.py          # Entry point
│   ├── generators/                 # Style generators (awesome, flat, classic, etc.)
│   ├── markup/                     # HTML/Markdown helpers
│   ├── helpers/                    # Shared utilities
│   └── svg_templates/              # SVG badge templates
├── validation/       # Link validation
│   ├── validate_links.py           # Bulk URL validator (GitHub rate-limit aware)
│   └── validate_single_resource.py
├── resources/        # Resource management
│   ├── create_resource_pr.py       # Automated PR creation for submissions
│   ├── parse_issue_form.py         # GitHub issue form parsing
│   ├── sort_resources.py           # CSV sorting
│   └── resource_utils.py
├── categories/       # Category management (category_manager singleton)
├── ids/              # Resource ID generation
├── badges/           # Badge notification system for merged resources
├── ticker/           # Repository statistics ticker
├── maintenance/      # Repo health checks, release data updates
├── testing/          # Integration tests, TOC anchor validation
├── graphics/         # SVG logo generation
├── utils/            # Git and GitHub utility functions
└── archive/          # Legacy scripts — DO NOT MODIFY, excluded from linting
```

---

## CI/CD

GitHub Actions workflows (`.github/workflows/`):

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Push, PR | Format-check, mypy, tests, docs-tree-check |
| `validate-links.yml` | Daily 2AM UTC | Validate all URLs, create issues for broken links |
| `submission-enforcement-v2.yml` | PR events | Cooldown enforcement, Claude-powered classification |
| `validate-new-issue.yml` | Issue opened | Validate new resource submission format |
| `handle-resource-submission-commands.yml` | `/approve`, `/reject`, `/request-changes` | Maintainer review commands |
| `notify-on-merge.yml` | PR merged | Badge notifications to resource authors |
| `update-github-release-data.yml` | Schedule | Update release version data in CSV |
| `update-repo-ticker.yml` | Schedule | Update repo statistics ticker |
| `check-repo-health.yml` | Schedule | Repository health monitoring |

The submission enforcement workflow uses **Claude Haiku** (`claude-haiku-4-5-20251001`) to classify PRs as resource submissions vs. maintenance changes.

**Pre-commit hooks** (`.pre-commit-config.yaml`) enforce:
- Large file detection, YAML/JSON validation, private key detection
- Ruff lint + format
- `make test` on Python file changes
- `make generate` to keep README in sync with CSV

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Avoid GitHub API rate limiting during link validation |
| `ANTHROPIC_API_KEY` | Used by submission-enforcement workflow (Claude classification) |
| `ACC_OPS` | Fine-grained PAT for ops repo state persistence |
| `CI` | Set to `true` in CI; switches Python from venv to system |
| `ALLOW_DIRTY` | Set to `1` to skip clean-tree check in `make test-regenerate` |
| `ALLOW_DIFF` | Set to `1` to allow diff after regeneration |
| `KEEP_README_OUTPUTS` | Set to `1` to keep generated files on failure for inspection |

---

## Slash Commands (`.claude/commands/`)

- **`/evaluate-repository`** (`evaluate-repository.md`) — Static security and quality review of a repository for inclusion in the list. Used by maintainers and contributors before submitting resources. Covers code quality, security/safety, documentation, functionality, and hygiene. Produces a scored report with a recommendation.

---

## Key Documentation

- `docs/CONTRIBUTING.md` — Contribution guidelines and submission process
- `docs/HOW_IT_WORKS.md` — Deep-dive on the automated submission system, label states, and README generation architecture
- `docs/README-GENERATION.md` — Detailed guide to the README generation pipeline
- `docs/TESTING.md` — Testing procedures and make targets
- `docs/COOLDOWN.md` — Submission spam prevention and cooldown system
- `scripts/README.md` — Overview of the scripts/ directory
