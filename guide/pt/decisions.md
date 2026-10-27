# Decisões de engenharia

**A forja escreve config; o promptfoo a executa.** Providers, concorrência, cache e o visualizador de resultados são do promptfoo. A forja cuida do que testar e do que significa "correto", e o emissor dela mora em módulo próprio, `src/emit`. O `--format jsonl` entrega a mesma seleção a um executor seu. O custo é ter um emissor só hoje e depender do formato de config do promptfoo.

**Aprovar é um ato humano.** Um item rascunhado fica pendente até uma pessoa decidir sobre ele no `review`. O manual do agente diz que um agente nunca marca nada como aprovado editando um arquivo e nunca roda o `review`, e o `emit` se recusa a escrever enquanto houver qualquer coisa pendente.

**Saídas esperadas são arquivos simples.** YAML dentro de `.forge/`, um arquivo de casos por cenário, de modo que mudar o que significa "correto" é um diff que alguém precisa ler e aprovar.

**Estimativas são faixas.** Nada da resposta real existe antes da rodada, então o `estimate` mostra uma faixa em torno do ponto, calibrada nas poucas rodadas que vêm aqui: um palpite, não um orçamento. Um provedor sem linha de preço fica sem preço e contado como deixado de fora, nunca precificado como outra coisa. A conta está em [`estimate`](running-a-suite.md#estimate).

**Selar é offline.** O `check` lê arquivos e compara; não chama modelo. Ele prova que uma rodada passou com aqueles insumos, não que a feature funciona.

**Escritas falham com segurança.**
- O `move` escreve o destino antes de tocar na origem, então uma falha no meio deixa uma duplicata, não um caso sumido.
- O primeiro Ctrl+C numa revisão salva o que foi decidido; um segundo antes do salvamento aborta sem escrever nada.
- O shim é escrito uma vez e nunca sobrescrito.

**Um binário, pacotes finos.**
- Todo canal instala o mesmo binário pré-compilado. O checksum dele é verificado, e a proveniência por uma atestação de artefato do GitHub assinada pelo workflow de release.
- Uma release final para se a atestação falha. Só uma tag de pré-release (com hífen, como `v0.2.0-rc.1`) num repositório privado segue com um aviso, já que os planos Free, Pro e Team do GitHub só têm atestações para repositórios públicos.
- Por isso o repositório precisa ser público, ou estar num plano com atestações para repositórios privados, antes da primeira release final.

**Um gate rigoroso.**
- Todo arquivo é mantido em 100% de cobertura de linhas e funções.
- Os cinco módulos (`core`, `cli`, `emit`, `report`, `llm`) passam por teste de mutação com o limite em 100, então um mutante sobrevivente é morto ou desligado com um motivo declarado.
- Os relatórios de exemplo commitados são regenerados a partir dos resultados brutos no CI, e os pacotes Ruby, Elixir e Python têm linters próprios.
- O bun não mede cobertura de branch, então um arquivo em 100% ainda pode esconder braços de guarda sem teste: o gate é um piso, não prova de que a suíte está completa.
