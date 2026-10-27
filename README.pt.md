🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

# LLM Tests Forge

[![ci](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![lint](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml) [![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Falbertosca%2Fllm-tests-forge%2Fbadges%2Fcoverage.json)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Suítes de regressão para as funcionalidades de LLM da sua aplicação: rascunhadas por um modelo, aprovadas por você e guardadas como arquivos simples no seu repositório.

![A forja em um terminal: status, a revisão de dois casos, estimate e report](assets/demo.gif)

## Início rápido

Por enquanto precisa do [bun](https://bun.sh) 1.4+: nada está publicado em registro ainda, então instale a partir de um clone.

```
git clone https://github.com/albertosca/llm-tests-forge.git
cd llm-tests-forge && bun install && bun link
```

Depois, dentro do projeto que tem o prompt e a função que chama o modelo (o drafter precisa de uma chave, como `ANTHROPIC_API_KEY`):

```
export FORGE_DRAFTER=anthropic/claude-sonnet-5
llm-tests-forge init
llm-tests-forge describe "o que a função faz" --prompt-file caminho/do/prompt.txt
llm-tests-forge review                      # aprove a funcionalidade
llm-tests-forge scenarios && llm-tests-forge review --only scenarios
llm-tests-forge cases --n 5 && llm-tests-forge review
llm-tests-forge estimate                    # o preço, antes de gastar
llm-tests-forge emit                        # .forge/promptfooconfig.yaml e um shim
npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json
llm-tests-forge report results.json
```

Preencha a única função que o shim nomeia para ela chamar o seu código, e a suíte testa a sua aplicação em vez de uma cópia do seu prompt. Duas suítes prontas, revisadas contra uma aplicação real, estão em [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/) e [`examples/moonlighter-extract-questions/`](examples/moonlighter-extract-questions/).

## Visão geral

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/flow-dark.svg">
  <img alt="Fluxo de um prompt a uma suíte do promptfoo: o seu prompt e a sua função são descritos à forja, que rascunha cenários e casos como arquivos YAML; você os revisa; o emit escreve uma config do promptfoo e um shim que chama a sua função; o promptfoo roda a suíte; a forja lê os resultados num relatório, que o stamp sela e o check verifica no CI." src="assets/diagrams/flow-light.svg" width="760">
</picture>

- **Prompt entra, suíte sai.** O `describe` lê a funcionalidade e o prompt dela; a forja rascunha cenários de seis tipos (happy, edge, ambiguous, out-of-scope, adversarial, language) e casos com uma saída esperada cada. O passo a passo está em [Do seu prompt a uma suíte do promptfoo](guide/pt/flow.md).
- **Exporta para o promptfoo.** O `emit` escreve uma config do promptfoo e um shim que chama a sua função em Python, JavaScript, TypeScript, Elixir, Ruby, Rust ou Go, ou qualquer comando ou endpoint HTTP. `--format jsonl` escreve os mesmos casos para um executor seu.
- **Você decide o que é correto.** O modelo rascunha; todo cenário e todo caso fica pendente até você aprovar no `review`, e o `emit` recusa enquanto houver algum pendente.
- **Custo e deriva.** O `estimate` precifica uma rodada antes de ela ser gasta, o `report` compara o custo real com ele, e o `stamp` sela uma rodada aprovada para o `check` verificar no CI, offline, que nada do que ela foi conquistada mudou.

## Garantias

- Um agente nunca aprova nada: aprovar é um ato da pessoa, e o manual que a forja entrega aos agentes diz isso.
- O `emit` não escreve nada enquanto houver cenário ou caso pendente, e nunca sobrescreve o shim que você preencheu.
- O `estimate` não faz chamada de API, mostra uma faixa em vez de um ponto, e deixa fora do total um modelo que não sabe precificar, em vez de chutar.
- O `check` lê arquivos e compara; não chama modelo.

## Notas de projeto

| Decisão | Custo |
|---|---|
| A forja escreve uma config e o promptfoo a executa | Um emissor hoje, e dependência do formato de config do promptfoo; nenhum executor próprio para manter. |
| As saídas esperadas são YAML no seu repositório | Mudar o que significa "correto" é um diff que alguém precisa ler; não há dataset hospedado para manter em sincronia. |
| Estimativas são faixas, calibradas em poucas rodadas commitadas | Um palpite calibrado, não um orçamento. |
| A selagem é offline | Prova que uma rodada passou com aquelas entradas, não que a funcionalidade funciona. |
| 100% de cobertura de linhas e funções, e testes de mutação em todo módulo | O Bun não mede cobertura de ramos, então o gate é um piso, não prova de que a suíte está completa. |

A lista completa está em [Decisões de engenharia](guide/pt/decisions.md).

## Limites

O promptfoo é o único emissor hoje. Testa um turno por vez, não guarda histórico além da comparação do `--baseline`, e ainda não está publicado em nenhum registro de pacotes. [Mais](guide/pt/development.md#limitações).

## Documentação

- [Do seu prompt a uma suíte do promptfoo](guide/pt/flow.md): o fluxo e o que o `emit` produz.
- [Instalação](guide/pt/install.md): canais, plataformas, verificação de um download.
- [Montando uma suíte](guide/pt/building-a-suite.md) e [Rodando uma suíte](guide/pt/running-a-suite.md): cada verbo.
- [Os nove tipos de alvo](guide/pt/targets.md): o shim de cada linguagem, `exec` e `http`.
- [Agentes, arquivos e códigos de saída](guide/pt/project-files.md): o que commitar em `.forge/`.
- [Limitações e desenvolvimento](guide/pt/development.md) e [Decisões de engenharia](guide/pt/decisions.md).

## Contribuindo e segurança

Leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir um pull request, reporte vulnerabilidades como o [SECURITY.md](SECURITY.md) descreve, e siga o [Código de Conduta](CODE_OF_CONDUCT.md). O que mudou em cada versão está no [changelog](CHANGELOG.md).

## Licença

MIT © Alberto Cavalcanti, veja o [LICENSE](LICENSE).
