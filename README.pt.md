🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml)

# llm-test-forge

Forja suítes de regressão revisadas para as funcionalidades de LLM da sua aplicação.

Você descreve o que a funcionalidade faz, e a forja enumera cenários de seis tipos (happy, edge, ambiguous, out-of-scope, adversarial, language), gera casos por cenário já com uma saída esperada, e deixa você revisar cada um deles em arquivos simples, um por um. Rodar a suíte, estimar custo e gerar uma config para um executor como o [promptfoo](https://promptfoo.dev) ainda não fazem parte desta ferramenta — veja "O que isso ainda não faz" logo abaixo.

## Instalação

Requer o [bun](https://bun.sh) 1.4 ou mais recente.

    bun install
    bun link      # expõe o `forge` no seu PATH

## Uso

Rode estes comandos nesta ordem, a partir da raiz da aplicação cuja funcionalidade de LLM você está testando.

    export FORGE_MODEL=google/gemini-3.5-flash
    forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file src/prompt.txt

Escreve `.forge/feature.yaml` como uma descrição estruturada e pendente da funcionalidade (propósito, entradas, formato da saída, invariantes). `--prompt-file` é opcional; passe-o quando a aplicação tiver um system prompt real que valha a pena copiar regras dele.

    forge review

Abre uma revisão interativa do que estiver pendente — aqui, a funcionalidade. Aprove, edite ou rejeite; a aprovação libera o próximo passo.

    forge scenarios

Gera `.forge/scenarios.yaml`: um conjunto de cenários cobrindo os seis tipos para a funcionalidade aprovada.

    forge review --only scenarios

Revisa os cenários pendentes, um por um.

    forge cases --n 5

Gera 5 casos pendentes por cenário aprovado em `.forge/cases/<scenario-id>.yaml`, cada um com uma saída esperada calculada a partir do formato de oráculo da funcionalidade (label, fields ou rubric).

    forge dedupe

Marca casos provavelmente duplicados dentro de cada cenário (`duplicate_of`), sem removê-los.

    forge import logs/real-inputs.jsonl

Lê um objeto JSON `{"input-name": "value"}` por linha a partir de logs reais de produção e os adiciona como casos pendentes no cenário `imported`, sem saída esperada — você fornece isso durante a revisão.

    forge review

Revisa tudo que ainda está pendente: casos (confirmando ou corrigindo a saída esperada) e qualquer caso importado (definindo sua saída esperada pela primeira vez).

No final, `.forge/` guarda `feature.yaml`, `scenarios.yaml` e `cases/<scenario>.yaml` — YAML simples, feito para ser commitado e comparado em diff como qualquer outra fixture de teste.

## O que isso ainda não faz

- Não roda a suíte contra um modelo nem compara as saídas.
- Não estima o custo em tokens de uma rodada antes de você gastar.
- Não gera uma config para o promptfoo nem para qualquer outro executor de testes.

Isso é um trabalho separado e posterior; veja `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md` para o design completo e onde esta ferramenta para hoje.

## Provedores

Defina `FORGE_MODEL` ou passe `--model` como `provider/model`:

| Provedor | Variável de ambiente | Exemplo |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | nenhuma (local) | `ollama/llama3` |
| `fake` | nenhuma | `fake/path/to/responses.json`, para testes |

## Desenvolvimento

    bun test          # testes unitários, sem rede, gate de 100% de cobertura
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, depois typecheck, depois test
    bun run test:live  # uma chamada real por verbo contra FORGE_MODEL, precisa de uma chave de provedor (FORGE_LIVE=1)

Design: `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md`.

## Licença

MIT — veja `LICENSE`.
