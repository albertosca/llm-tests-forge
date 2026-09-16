🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-test-forge/actions/workflows/ci.yml)

# llm-test-forge

Forja suítes de regressão revisadas para as funcionalidades de LLM da sua aplicação.

Você descreve o que a funcionalidade faz, e a forja enumera cenários de seis tipos (happy, edge, ambiguous, out-of-scope, adversarial, language), gera casos por cenário já com uma saída esperada, e deixa você revisar cada um deles em arquivos simples, um por um. Depois ela calcula o preço da rodada antes de você gastar, gera uma config para o [promptfoo](https://promptfoo.dev) executar, e transforma a saída do promptfoo de volta em um relatório com tabela por cenário, casos instáveis e custo real contra o estimado.

Uma suíte pronta, gerada e revisada contra uma aplicação real: [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/).

## Instalação

Requer o [bun](https://bun.sh) 1.4 ou mais recente. Ainda não está publicado no npm, então instale a partir de um clone.

    git clone https://github.com/albertosca/llm-test-forge.git
    cd llm-test-forge
    bun install
    bun link      # expõe o `forge` no seu PATH

## Uso

Rode estes comandos nesta ordem, a partir da raiz da aplicação cuja funcionalidade de LLM você está testando.

    export FORGE_MODEL=google/gemini-3.5-flash
    forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file src/prompt.txt

Escreve `.forge/feature.yaml` como uma descrição estruturada e pendente da funcionalidade (propósito, entradas, formato da saída, invariantes). `--prompt-file` é opcional; passe-o quando a aplicação tiver um system prompt real que valha a pena copiar regras dele. Rodar `describe` de novo por cima de uma funcionalidade que você já revisou é recusado, porque sobrescreveria as invariantes que você escreveu à mão; passe `--force` quando substituir for exatamente o que você quer.

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

Os três verbos restantes transformam essa suíte em uma rodada. Eles leem o `.forge/suite.yaml`, que você escreve à mão: contra o que a suíte roda, quais modelos julgam um caso `rubric`, e quantas vezes cada caso se repete.

    # .forge/suite.yaml
    target:
      kind: promptfoo-python
      entry: forge_target.py
      python: .venv/bin/python        # um interpretador que consiga importar a sua aplicação
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # vazio = todos os cenários revisados

    forge estimate

Calcula o preço da rodada antes de você gastar: casos × modelos alvo × `repeat`, mais uma chamada de juiz por caso `rubric` por juiz, modelo alvo e `repeat`, contra o `prices.yaml` (que é seu para editar — a saída imprime a data que ele carrega e marca com `~` qualquer modelo que teve de ser precificado pelo irmão mais próximo da lista). Os tokens são contados como caracteres ÷ 4, então leia o número como ordem de grandeza. Não faz nenhuma chamada de API.

    forge emit

Escreve o `.forge/promptfooconfig.yaml` a partir dos casos aprovados: um teste por caso com as entradas como `vars`, um assert `javascript` para o oráculo `label` ou `fields`, e um `llm-rubric` por juiz no caso de `rubric`. Recusa-se a gerar enquanto houver qualquer coisa pendente, e diz o quê. Na primeira vez também escreve o `.forge/forge_target.py` e nunca mais o sobrescreve — **edite o `run_application` dele para chamar a sua aplicação**, que é o que faz a suíte testar o seu código em vez de uma cópia do seu prompt. Com `--format jsonl`, escreve a mesma seleção em `.forge/cases.jsonl`, para um executor seu.

    bunx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

O promptfoo roda a suíte; a forja não roda por você e não precisa do promptfoo instalado.

    forge report results.json [--baseline .forge/report.json]

Lê a saída do promptfoo para `.forge/report.md` e `.forge/report.json`: taxa de acerto, tabela por cenário, quais cenários aprovados não chegaram a rodar, casos que passaram em uma repetição e falharam em outra, juízes que discordaram (com as duas justificativas) e custo real contra o estimado. Com `--baseline`, um `report.json` anterior é comparado e as regressões vêm primeiro.

### O que commitar dentro de `.forge/`

Commite `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, `forge_target.py` e `report.md`/`report.json`: eles são a suíte revisada, a rodada que ela descreve e o resultado, e o diff deles é justamente o ponto. Coloque no gitignore o `usage.jsonl` e o `failures/`, que guardam contagem de tokens e a saída crua do modelo nas suas rodadas, e decida deliberadamente sobre o `cases/imported.yaml` — o `import` o preenche com entradas reais de produção, que podem ser dados que você não pode colocar num repositório.

### Códigos de saída

| Código | Significa |
|---|---|
| `0` | o verbo fez o que promete |
| `1` | o trabalho falhou: um arquivo que não existe, um modelo que recusou, uma funcionalidade ainda pendente de revisão |
| `2` | a linha de comando é inutilizável: verbo ou opção desconhecida, valor de flag inválido, argumento obrigatório ausente, nenhum modelo configurado |

## O que isso ainda não faz

- Não chama o promptfoo por você: o `forge emit` escreve a config e você roda a avaliação.
- Não existe servidor MCP, então o loop de revisão não roda dentro de uma conversa.
- Testa um turno por vez. Casos multi-turno, em que a própria resposta da aplicação molda o turno seguinte, precisam de um usuário simulado, que isto não é.
- Não guarda histórico: o `--baseline` compara duas rodadas, e nada as acumula ao longo do tempo.

Veja `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md` para o design completo e `docs/superpowers/BACKLOG.md` para o que foi adiado e por quê.

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

    bun test          # testes unitários, sem rede, gate de cobertura
    bun run lint       # Biome
    bun run typecheck  # tsc --noEmit
    bun run check      # lint, depois typecheck, depois test
    bun run test:live  # duas chamadas reais contra google/gemini-3.5-flash por padrão (FORGE_LIVE=1); sobrescreva com FORGE_MODEL
    bun run validate:example  # valida o promptfooconfig.yaml do exemplo commitado com o promptfoo de verdade; sem API key

O gate de cobertura é o do próprio bun: um piso de 1,0 sobre **linhas e funções**, com `src/cli/bin.ts` excluído. O bun não mede cobertura de branch nenhuma, então um arquivo em 100% ainda pode ter braços de guarda sem teste — leia o gate como um piso, não como prova de que a suíte está completa.

O `test:live` precisa de `GOOGLE_API_KEY` e falha de forma explícita (não em silêncio) se ela estiver ausente. O free tier do Google é intermitente, não simplesmente indisponível, então o teste tenta de novo uma resposta 503/"high demand" até 3 vezes com uma pausa curta entre as tentativas; qualquer outra falha (cota, autenticação, um model id desconhecido, um schema que não bate) falha já na primeira ocorrência em vez de tentar de novo.

Design: `docs/superpowers/specs/2026-09-14-llm-test-forge-design.md`.

## Licença

MIT — veja `LICENSE`.
