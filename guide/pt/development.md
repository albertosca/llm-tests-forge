# Limitações e desenvolvimento

## Limitações

- Não chama o promptfoo por você: o `llm-tests-forge emit` escreve a config e você roda a avaliação.
- O promptfoo é o único emissor hoje.
- Não existe servidor MCP, então o loop de revisão não roda dentro de uma conversa.
- Testa um turno por vez. Casos multi-turno, em que a própria resposta da aplicação molda o turno seguinte, precisam de um usuário simulado, que isto não é.
- Não guarda histórico: o `--baseline` compara duas rodadas, e nada as acumula ao longo do tempo.

## Desenvolvimento

    bun test          # testes unitários, sem rede, gate de cobertura
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, depois typecheck, depois test
    bun run test:live  # duas chamadas reais contra google/gemini-3.5-flash por padrão (FORGE_LIVE=1); sobrescreva com FORGE_DRAFTER
    bun run test:shims # roda cada shim contra a toolchain real e o promptfoo (FORGE_SHIMS=1); lento, precisa das toolchains
    bun run validate:example  # valida o promptfooconfig.yaml do exemplo commitado com o promptfoo de verdade; sem API key

O `test:live` precisa de `GOOGLE_API_KEY` e falha de forma explícita (não em silêncio) se ela estiver ausente. O free tier do Google é intermitente, não simplesmente indisponível, então:
- uma resposta 503 ou "high demand" é repetida, até 3 tentativas com uma pausa curta entre elas;
- qualquer outra falha (cota, autenticação, um model id desconhecido, um schema que não bate) falha já na primeira ocorrência.

Os alvos de release ficam em `scripts/release/targets.ts`. Antes de remover um, saiba que o pip e o RubyGems põem uma versão mais nova acima de uma plataforma que casa: o wheel e o gem reserva da release seguinte passariam na frente do pacote de plataforma antigo naquela plataforma, e quem atualizar ali recebe a mensagem de "sem binário" no lugar do binário que tinha.
