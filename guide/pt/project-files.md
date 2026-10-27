# Agentes, arquivos e códigos de saída

## Agentes

O `init` adiciona ao `AGENTS.md` um bloco que aponta um agente para `llm-tests-forge status` e `llm-tests-forge guide`. A regra desse manual é a que importa: aprovar é trabalho da pessoa, então um agente nunca marca nada como aprovado editando um arquivo e nunca roda o `review` por você.

Uma skill do Claude Code (`plugin/skills/llm-tests-forge/`) é um ponteiro fino para o mesmo manual. O comando de instalação é `/plugin marketplace add albertosca/llm-tests-forge`, e ele funciona quando o repositório for público. Até lá, `/plugin marketplace add <caminho do seu clone>` a instala a partir de um checkout local.

## O que commitar dentro de `.forge/`

Commite:
- o `forge.yaml`;
- em cada suíte, `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, o shim e `report.md`/`report.json`.

Eles são a suíte revisada, a rodada que ela descreve e o resultado, e o diff deles é justamente o ponto.

Coloque no gitignore o `usage.jsonl` e o `failures/`, que guardam contagem de tokens e a saída crua do modelo nas suas rodadas.

Decida deliberadamente sobre o `cases/imported.yaml`: o `import` o preenche com entradas reais de produção, que podem ser dados que você não pode colocar num repositório.

## Códigos de saída

| Código | Significa |
|---|---|
| `0` | o verbo fez o que promete |
| `1` | o trabalho falhou: um arquivo que não existe, um modelo que recusou, uma funcionalidade ainda pendente de revisão |
| `2` | a linha de comando é inutilizável: verbo ou opção desconhecida, valor de flag inválido, argumento obrigatório ausente, nenhum modelo configurado |
