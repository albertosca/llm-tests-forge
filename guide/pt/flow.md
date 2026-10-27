# Do seu prompt a uma suíte do promptfoo

A forja fica entre o código que chama o seu modelo e o [promptfoo](https://promptfoo.dev), que roda os testes. Ela decide o que testar e o que significa "correto"; o promptfoo executa. Nada no meio é um serviço: cada passo lê e escreve arquivos simples em `.forge/`, ao lado do seu código.

## O caminho, passo a passo

| # | Você roda | A forja escreve | Quem decide |
|---|---|---|---|
| 1 | `init` | `forge.yaml`, um bloco no `AGENTS.md` | você |
| 2 | `describe "..." --prompt-file prompt.txt` | `.forge/feature.yaml`: propósito, entradas, formato da saída, invariantes | o drafter propõe, você aprova no `review` |
| 3 | `scenarios` | `.forge/scenarios.yaml`: situações de seis tipos (happy, edge, ambiguous, out-of-scope, adversarial, language) | o drafter propõe, você aprova |
| 4 | `cases --n 5` | `.forge/cases/<scenario>.yaml`: entradas, uma saída esperada e um oracle (`label`, `fields` ou `rubric`) | o drafter propõe, você confirma ou corrige cada um |
| 5 | `dedupe`, opcionalmente `import logs.jsonl`, depois `review` | marca duplicatas; adiciona entradas reais de produção como casos que você completa | você |
| 6 | `estimate` | nada; mostra uma faixa de preço, sem chamar API | você lê antes de gastar |
| 7 | `emit` | `.forge/promptfooconfig.yaml` e, uma vez, um shim na sua linguagem | o `emit` recusa enquanto houver algo pendente |
| 8 | `npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json` | o `results.json` do promptfoo (sai com 100 quando algum teste falha: um resultado, não uma quebra) | promptfoo |
| 9 | `report results.json [--baseline]` | `.forge/report.md` e `.forge/report.json` | você lê |
| 10 | `stamp results.json`, depois `check` no CI | `.forge/stamp.json`; o `check` é offline e não chama modelo | você sela, o CI confere |

O prompt que você passa ao `describe` é lido uma vez, para copiar as regras dele para a descrição da funcionalidade. Depois disso a suíte testa o que o seu código fizer, por meio do shim.

## O que o `emit` produz

**A config.** Um teste do promptfoo por caso aprovado, com as entradas do caso como `vars`. Um oracle `label` ou `fields` vira um assert `javascript`; um `rubric` vira um `llm-rubric` por juiz. Um exemplo reduzido, de [`examples/moonlighter-classify-email/`](../../examples/moonlighter-classify-email/):

    providers:
      - id: file://forge_target.py
        label: anthropic/claude-haiku-4-5
        config:
          model: anthropic/claude-haiku-4-5
    tests:
      - description: standard-interview-request-email-01
        vars:
          from: Priya Nair <priya.nair@brightwave.io>
          subject: Interview Invitation - Senior Backend Engineer
          body: ...
        assert:
          - type: javascript
            value: ... # parses the output and compares "type" with "interview"

**O shim.** O promptfoo o chama uma vez por caso e por modelo alvo. O trabalho dele é chamar a *sua* função com as entradas do caso e devolver a resposta, e é isso que faz a suíte testar a sua aplicação e não uma cópia do seu prompt. O `emit` o escreve uma vez e nunca o sobrescreve; você preenche a única função que ele nomeia.

| Seu código é | O shim é | Você preenche |
|---|---|---|
| Python | `forge_target.py` | `run_application` |
| JavaScript / TypeScript | `forge_target.mjs` / `forge_target.ts` | `runApplication` |
| Elixir | `forge_target.exs`, via `mix run` | `run_application/2` |
| Ruby | `forge_target.rb` | `run_application` |
| Rust / Go | um crate / módulo pequeno | `run_application` / `runApplication` |
| qualquer outro | nada | `target.command` (qualquer programa) ou `target.url` (um endpoint HTTP) no `suite.yaml` |

Os detalhes de cada tipo, incluindo os contratos de `exec` e `http`, estão em [Os nove tipos de alvo](targets.md).

**Um executor seu.** `emit --format jsonl` escreve a mesma seleção aprovada em `.forge/cases.jsonl`, para uma ferramenta que não seja o promptfoo. O promptfoo é o único emissor hoje; outros estão planejados, e cada um leria os mesmos arquivos revisados.

## Onde cada passo está documentado

- Passos 1 a 5: [Montando uma suíte](building-a-suite.md).
- Passos 6 a 10: [Rodando uma suíte](running-a-suite.md).
- Quais arquivos commitar, como um agente entra, códigos de saída: [Agentes, arquivos e códigos de saída](project-files.md).
