# pi-multi-grep

After numerous times seeing agents being confused by bash-style `grep` tool syntax and struggle with the default Pi `grep` tool, I decided to create this extension.

`pi-multi-grep` is a simple Pi extension that replaces the built-in `grep` tool with an array-first version for multiple search targets and multiple glob filters. It still uses `ripgrep` underneath.

So now agent:
- stop being confused by the `grep` syntax
- can search multiple paths at once


## Installation

```bash
pi install npm:pi-multi-grep
```

## Usage

```json
{
  "pattern": "TODO",
  "paths": ["src", "packages"],
  "globs": ["*.ts", "*.tsx", "!*.test.ts"]
}
```

`paths` defaults to the current directory when omitted. `globs` is optional.
