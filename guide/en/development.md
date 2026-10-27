# Limitations and development

## Limitations

- It does not call promptfoo for you: `llm-tests-forge emit` writes the config and you run the eval yourself.
- promptfoo is the only emitter today.
- There is no MCP server, so the review loop cannot run inside a conversation.
- It tests one turn at a time. Multi-turn cases where your application's own reply shapes the next turn need a simulated user, which this is not.
- It keeps no history: `--baseline` compares two runs, and nothing collects them over time.
- It is not published to any package registry yet.

## Development

    bun test          # unit tests, no network, coverage gate
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, then typecheck, then test
    bun run test:live  # two real calls against google/gemini-3.5-flash by default (FORGE_LIVE=1); override with FORGE_DRAFTER
    bun run test:shims # runs every shim against its real toolchain and promptfoo (FORGE_SHIMS=1); slow, needs the toolchains
    bun run validate:example  # checks the committed example's promptfooconfig.yaml with the real promptfoo; no API key

`test:live` needs `GOOGLE_API_KEY` and fails loudly (not silently) if it is unset. Google's free tier is intermittent rather than simply down, so:
- a 503 or "high demand" response is retried, up to 3 attempts with a short pause between them;
- any other failure (quota, auth, an unknown model id, a schema mismatch) fails on the first occurrence.

The release targets live in `scripts/release/targets.ts`. Before you drop one, know that pip and RubyGems rank a newer version above a platform match: the next release's fallback wheel and gem would outrank the older platform package on that platform, so anyone who upgrades there gets the "no binary" message instead of the binary they had.
