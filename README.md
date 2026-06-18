# github-pr-status

Generate Slack-ready PR status summary for a team. Reads search criteria from a YAML config, queries GitHub via `gh`, copies a rich-formatted list to the macOS clipboard ready to paste into Slack.

## Requirements

- [Bun](https://bun.com)
- [`gh`](https://cli.github.com) CLI, authenticated (`gh auth login`)
- macOS (uses `swift` + `NSPasteboard` for HTML clipboard — Xcode Command Line Tools)

## Install dependencies

```bash
bun install
```

## Configure

Copy `pr-status.yaml` and edit for your team:

```yaml
repo: Onebrief/bc
keyword: GTM
authors:
  - Christopher-Xu
  - jhatter-ob
```

## Run from source

```bash
bun run index.ts                 # uses ./pr-status.yaml
bun run index.ts ~/my-team.yaml  # custom config path
```

## Build + install globally (one-liner)

```bash
bun run build && mkdir -p ~/.local/bin && mv pr-status ~/.local/bin/ && (echo $PATH | grep -q "$HOME/.local/bin" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc)
```

Then `source ~/.zshrc` (or open a new shell) and run anywhere:

```bash
pr-status ~/path/to/your-team.yaml
```
