# AGENTS.md

## Purpose

This repository is a **public setup template** for sharing pi agent configuration across machines. Users clone it to`~/.pi/agent/` to get a preconfigured environment with extensions, skills, prompts, and agents.

## Directory Structure

```
~/.pi/agent/
├── settings.json       # Global settings (model, provider, theme, packages)
├── auth.json           # Authentication tokens (NEVER commit)
├── sessions/           # Conversation histories (NEVER commit)
├── extensions/         # TypeScript extensions
├── skills/             #Skills (symlinks to ~/.agents/skills/)
├── prompts/            # Prompt templates (/init, etc.)
└── agents/             # Subagent definitions (scout, planner, etc.)
```

## Git Ignore Rules

**Never commit:**
- `auth.json` - Contains API tokens
- `sessions/` - Contains conversation histories
- `*.lock.json` - Machine-specific lock files
- Any files with API keys, tokens, credentials

**Safe to commit:**
- `settings.json` - Non-sensitive configuration
- `extensions/*.ts` - Extension source code
- `skills/` - Skill definitions (symlinks resolve elsewhere)
- `prompts/*.md` - Prompt templates
- `agents/*.md` - Subagent definitions

## Adding New Plugins

Before committing:
1. Check if plugin creates sensitive files
2. Add patterns to `.gitignore` if needed
3. Verify `settings.json` has no hardcoded credentials
4. Test on clean clone to ensure setup works