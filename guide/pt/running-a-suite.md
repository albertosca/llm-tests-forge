# Rodando uma suíte

Os verbos restantes transformam essa suíte em uma rodada. Eles leem o `.forge/suite.yaml`, que o `describe` pode ter começado para você e que, fora isso, você escreve à mão. Ele diz contra o que a suíte roda, quais modelos julgam um caso `rubric` e quantas vezes cada caso se repete.

    # .forge/suite.yaml
    target:
      kind: python
      entry: forge_target.py          # opcional: o shim, quando não é o nome padrão
      python: .venv/bin/python        # um interpretador que consiga importar a sua aplicação
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # vazio = todos os cenários aprovados

- `target.kind` é um dos nove tipos [abaixo](targets.md). `kind: promptfoo-python`, que suítes antigas carregam, continua sendo lido como `python`.
- As chaves específicas de cada tipo são `target.python` (python), `target.command` (exec) e `target.url`, `target.method`, `target.headers`, `target.body` e `target.response` (http).

### `estimate`

    llm-tests-forge estimate

Calcula o preço da rodada antes de você gastar. Não faz nenhuma chamada de API.

- **O que ele conta:** casos × modelos alvo × `repeat`, mais uma chamada de juiz por caso `rubric` por juiz, modelo alvo e `repeat`.
- **De onde vêm os preços:** do `prices.yaml`, que é seu para editar. A saída imprime a data que o arquivo carrega e marca com `~` qualquer modelo que teve de ser precificado pelo irmão mais próximo da lista.
- **Provedores desconhecidos:** um modelo cujo provedor não tem nenhuma linha na tabela não é precificado de jeito nenhum. A linha dele mostra `not priced`, e o total o deixa de fora dizendo quantas linhas ficaram de fora.
- **Os tokens** são contados como caracteres ÷ 4. Cada linha e o total mostram uma faixa em torno desse ponto, `$mínimo–$máximo (point $ponto)`, montada com três peças:
  - a entrada, recontada a 3,5 a 4,2 caracteres por token;
  - o acréscimo do prompt do juiz e o tamanho da resposta dele, tirados de rodadas registradas;
  - a saída do alvo, a 0,5× a 1,25× de um tamanho estimado pelo `output.kind` (ou pelos valores esperados revisados), porque nada do texto da resposta real existe antes da rodada.
- **Quanto confiar:** as faixas foram ajustadas às poucas rodadas que vêm com este repositório, então leia a faixa como um palpite calibrado, não como um orçamento.

### `emit`

    llm-tests-forge emit

Escreve o `.forge/promptfooconfig.yaml` a partir dos casos aprovados:
- um teste por caso, com as entradas como `vars`;
- um assert `javascript` para o oráculo `label` ou `fields`, e um `llm-rubric` por juiz no caso de `rubric`;
- uma recusa, dizendo o quê, enquanto houver qualquer coisa pendente.

Na primeira vez também escreve o shim da sua linguagem, uma vez só e nunca mais sobrescrito. **Preencha a função que ele nomeia para chamar a sua aplicação**: é isso que faz a suíte testar o seu código em vez de uma cópia do seu prompt.

Com `--format jsonl`, escreve a mesma seleção em `.forge/cases.jsonl`, para um executor seu.

### Rode o promptfoo

    npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

O promptfoo roda a suíte a partir do diretório da suíte (`bunx` também serve). A forja não roda por você. O promptfoo sai com status 100 quando algum teste falha: isso é um resultado, não uma queda.

### `report`

    llm-tests-forge report results.json [--baseline .forge/report.json]

Lê a saída do promptfoo para `.forge/report.md` e `.forge/report.json`. Eles mostram:
- a taxa de acerto e uma tabela por cenário;
- quais cenários revisados não têm caso, não tiveram rodada casada ou não estão nesta suíte;
- casos que passaram em uma repetição e falharam em outra;
- juízes que discordaram, com as duas justificativas;
- o custo real contra a faixa estimada: dentro dela, ou quanto acima ou abaixo do limite mais próximo. Uma linha que não registrou tokens diz isso em vez de afirmar que bateu.

Com `--baseline`, um `report.json` anterior é comparado:
- as regressões vêm primeiro;
- pares que a baseline tem e esta rodada não (depois de um rename, por exemplo) são nomeados em vez de sumirem do diff em silêncio;
- uma baseline escrita por uma versão mais antiga da forja é aceita, inclusive as chaves que ela escrevia com outro nome.

### `stamp` e `check`

    llm-tests-forge stamp results.json
    llm-tests-forge check

Uma rodada só protege se algo avisar quando os insumos dela mudam.

O **`stamp`** sela uma rodada aprovada aos arquivos que você lista no `suite.yaml` (`stamp.inputs`: o arquivo de prompt, um lockfile; `stamp.minimum_pass_rate`: a linha), em `.forge/stamp.json`, que você commita. Ele recusa, sem escrever nada, enquanto:
- algum caso falha em todas as repetições;
- a taxa de acerto está abaixo da linha;
- falta um insumo.

Um caso que falhou só em algumas repetições entra na lista do stamp e não bloqueia.

O **`check`** é o que o CI roda: offline, sem chamada de modelo. Sai com 1 nomeando:
- o insumo que mudou, sumiu ou apareceu;
- o modelo alvo ou o juiz diferente do selado;
- uma linha subida acima da taxa selada.

Ele só avisa quando a versão da forja ou do promptfoo difere.

Selar é um passo do mantenedor depois de ler o relatório. O stamp prova que uma rodada passou com aqueles insumos, não que a feature funciona.
