🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

# LLM Tests Forge

[![CI](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![Lint](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml) [![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Falbertosca%2Fllm-tests-forge%2Fbadges%2Fcoverage.json)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Suítes de regressão para as funcionalidades de LLM da sua aplicação: rascunhadas por um modelo, aprovadas por você e guardadas como arquivos simples no seu repositório.

![A forja em um terminal: status, a revisão de dois casos, estimate e report](assets/demo.gif)

## Início rápido

A forja é um comando só de desenvolvimento que você instala ao lado do seu projeto, nunca dentro do seu código: ela escreve tudo em `.forge/`, e quem chama a sua função, por um shim pequeno, é o promptfoo, que roda à parte pelo `npx`. Ela entra como dependência de desenvolvimento pelo npm; os outros canais estão em [Instalação](guide/pt/install.md).

Instale no projeto que tem o prompt, com Node 16.9 ou mais novo:

```
npm i -D llm-tests-forge
```

Depois, dentro desse projeto que tem o prompt e a função que chama o modelo (o drafter precisa de uma chave, como `ANTHROPIC_API_KEY`):

```
export FORGE_DRAFTER=anthropic/claude-sonnet-5
npx llm-tests-forge init
npx llm-tests-forge describe "o que a função faz" --prompt-file caminho/do/prompt.txt
npx llm-tests-forge review      # aprove; depois repita scenarios, cases e review
npx llm-tests-forge emit        # escreve .forge/promptfooconfig.yaml e um shim
```

Preencha a única função que o shim nomeia para ela chamar o seu código e rode `npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml`. A cadeia completa, com `estimate` e `report`, está em [Do seu prompt a uma suíte do promptfoo](guide/pt/flow.md); duas suítes prontas estão em [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/) e [`examples/moonlighter-extract-questions/`](examples/moonlighter-extract-questions/).

## Visão geral

Você aponta a forja para um prompt e para a função que chama o modelo; um modelo rascunha cenários e casos de teste, cada um com uma saída esperada, e você revisa e aprova todos eles. A forja então exporta a suíte aprovada como uma config do promptfoo mais um shim que chama a sua função, e o promptfoo a roda contra o seu código de verdade, enquanto a forja relata o resultado e o custo.

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

O promptfoo é o único emissor hoje. Testa um turno por vez, não guarda histórico além da comparação do `--baseline`. [Mais](guide/pt/development.md#limitações).

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
