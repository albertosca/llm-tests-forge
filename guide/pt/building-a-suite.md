# Montando uma suíte

O fluxo inteiro, em ordem. Cada passo tem a sua entrada logo abaixo.

1. `init`, uma vez por projeto.
2. `describe` e depois `review`: a forja escreve uma descrição da funcionalidade, e você a aprova.
3. `scenarios` e depois `review --only scenarios`: as situações que a funcionalidade precisa tratar, aprovadas por você.
4. `cases`, depois `dedupe`, opcionalmente `import`, depois `review`: os casos e suas saídas esperadas, aprovados por você.
5. `estimate` e depois `emit`: o preço, e então a config do promptfoo.
6. Rode o promptfoo você mesmo e depois `report`.
7. Opcionalmente, `stamp` depois de uma boa rodada, e `check` no CI.

## Preparando um projeto

Rode estes comandos de dentro do projeto cuja funcionalidade de LLM você está testando.

### `init`

    llm-tests-forge init

Prepara o projeto:
- Detecta a linguagem do projeto e escreve o `forge.yaml` na raiz. `--language` sobrescreve a detecção.
- Adiciona ao `AGENTS.md` um bloco sobre a forja, criando o arquivo se não houver.
- Num projeto que já tem `forge.yaml`, deixa-o intocado e só atualiza o bloco do `AGENTS.md`, então `--language` não faz nada ali.

O `forge.yaml` lista as suítes e guarda os padrões. Ele nasce com `suites: []` e os padrões comentados, e o `describe` acrescenta cada suíte nova à lista. Uma suíte que já existia (copiada de outro lugar, ou criada antes do `init`) não é acrescentada por nenhum verbo: escreva o caminho dela em `suites:` você mesmo (por exemplo `suites: [evals/classify]`). Um já preenchido fica assim:

    # forge.yaml
    version: 1
    language: python
    suites: [evals/classify_response]
    defaults:
      drafter: anthropic/claude-sonnet-5
      target_models: [anthropic/claude-haiku-4-5]
      judges: [anthropic/claude-sonnet-5]

Há uma suíte por função testada, por convenção em `evals/<função>/`, cada uma um diretório com um `.forge/` dentro.

### `status`

    llm-tests-forge status

Uma linha por suíte registrada, mostrando:
- a funcionalidade, marcada `(feature pending)` enquanto espera revisão;
- os cenários e os casos como aprovados e pendentes (cenários rejeitados aparecem à parte, nunca nessas contagens);
- a última rodada e qualquer aviso de versão.

`status --json` imprime o mesmo para um programa, com `featureStatus` e `scenarios: { approved, pending, rejected }`. É assim que uma pessoa, ou um agente sem histórico de conversa, descobre o que existe e o que está pendente.

### `guide`

    llm-tests-forge guide

Imprime o manual para um agente que opera a forja. Ele é embutido no binário instalado, por isso sempre igual à versão instalada.

### Escolhendo a suíte

- `--suite <caminho>` (um caminho relativo à raiz do projeto) roda qualquer verbo numa suíte registrada de qualquer ponto dentro do projeto.
- Sem ele, o verbo usa a suíte do diretório atual.
- Um diretório com `.forge/` e sem `forge.yaml` acima continua funcionando como suíte avulsa.

## O drafter

O drafter é o modelo que escreve a funcionalidade, os cenários e os casos. Tudo o que ele escreve chega pendente.

Defina-o nesta ordem de precedência: `--drafter provider/model`, senão `FORGE_DRAFTER`, senão `defaults.drafter` no `forge.yaml`. As chaves vêm primeiro do ambiente, e `~/.config/<provider>/api.env` é o plano B.

| Provedor | Variável de ambiente | Exemplo |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | nenhuma (local) | `ollama/llama3` |
| `fake` | nenhuma | `fake/path/to/responses.json`, para testes |

## Montando uma suíte

Crie o diretório da suíte, entre nele e rode os verbos nesta ordem:

    mkdir -p evals/classify_response && cd evals/classify_response
    export FORGE_DRAFTER=google/gemini-3.5-flash

    llm-tests-forge describe "..." --prompt-file ../../src/prompt.txt
    llm-tests-forge review
    llm-tests-forge scenarios
    llm-tests-forge review --only scenarios
    llm-tests-forge cases --n 5
    llm-tests-forge dedupe
    llm-tests-forge import ../../logs/real-inputs.jsonl     # opcional
    llm-tests-forge review

### `describe`

    llm-tests-forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file ../../src/prompt.txt

Escreve `.forge/feature.yaml` como uma descrição estruturada e pendente da funcionalidade: propósito, entradas, formato da saída, invariantes.

- **Os nomes das entradas** viram variáveis de template do promptfoo. Levam letras ASCII, dígitos e sublinhados, começam por letra (um sublinhado inicial é do próprio promptfoo) e não são nenhum de `not`, `true`, `false`, `none`, `null`. Escreva `user_message`, não `user message`. Um `feature.yaml` com qualquer outro nome é recusado.
- **Renomear uma entrada** é renomeá-la no `feature.yaml`, nas chaves de `input:` de todo caso e no código do target ou do shim. Até lá, `estimate`, `emit` e `report` recusam um caso aprovado cujas chaves de entrada não batem com as entradas da funcionalidade.
- **`--prompt-file`** é opcional. Passe-o quando a função tiver um system prompt real que valha a pena copiar regras dele. O caminho é relativo a onde você roda o comando, daí o `../../` a partir de `evals/classify_response`.
- **Rodá-lo de novo** por cima de uma funcionalidade que você já revisou é recusado, porque sobrescreveria as invariantes que você escreveu à mão. Passe `--force` quando substituir for exatamente o que você quer.
- **Ele também escreve um `suite.yaml` inicial** quando as três condições valem: ainda não existe `suite.yaml`, a linguagem do projeto não é `other` e o `forge.yaml` define `defaults.target_models` e `defaults.judges`.

### `scenarios`

    llm-tests-forge scenarios

Gera `.forge/scenarios.yaml`: um conjunto de cenários cobrindo os seis tipos para a funcionalidade aprovada. `--more <n>` gera mais depois.

### `cases`

    llm-tests-forge cases --n 5

Gera 5 casos pendentes por cenário aprovado em `.forge/cases/<scenario-id>.yaml`. Cada um tem uma saída esperada calculada a partir do formato de oráculo da funcionalidade (`label`, `fields` ou `rubric`). `--scenario <id>` gera casos só para um cenário.

### `dedupe`

    llm-tests-forge dedupe

Marca casos provavelmente duplicados dentro de cada cenário (`duplicate_of`), sem removê-los. Ele só mexe em casos pendentes, por isso vem antes da revisão dos casos.

### `import`

    llm-tests-forge import ../../logs/real-inputs.jsonl

Lê um objeto JSON `{"input-name": "value"}` por linha a partir de logs reais de produção e os adiciona como casos pendentes no cenário `imported`. Eles não têm saída esperada: você a fornece durante a revisão.

### `review`

    llm-tests-forge review
    llm-tests-forge review --only scenarios

Abre uma revisão interativa do que estiver pendente. Na primeira vez, é a funcionalidade: aprove, edite ou rejeite, e a aprovação libera o próximo passo. Depois ela cobre os cenários, os casos (confirmando ou corrigindo a saída esperada) e os casos importados (definindo a saída esperada pela primeira vez). Apertar Enter numa linha vazia pergunta antes de pular.

As palavras que a tela de revisão usa:
- **pendente**: espera a sua decisão.
- **expected**: a resposta que o redator propõe para um caso, e que você confirma ou corrige.
- **oracle**: como um caso é verificado. `label`: a resposta deve sair exatamente como esse rótulo. `fields`: seus campos devem bater com estes valores. `rubric`: um modelo juiz avalia a resposta contra uma frase.
- **cenário**: uma situação que um grupo de casos cobre.
- **revisão**: a passada em que você decide sobre cada item pendente.

O que a revisão não muda para você:
- O `id` de um cenário e o campo `scenario` de um caso, porque os dois nomeiam o arquivo onde os casos moram (`.forge/cases/<scenario>.yaml`). A recusa diz qual chamada de `llm-tests-forge move` faz isso.

O que uma edição pode desencadear:
- Editar o `oracle` de um cenário reabre os casos aprovados daquele cenário cujo esperado o novo oráculo não aceita mais. Cada um precisa então de `edit` para ganhar um esperado no novo formato, não de `approve`.

Interrompendo:
- Um Ctrl+C salva o que já foi decidido.
- Um segundo, antes de o salvamento começar, aborta sem escrever nada.
- Um durante o salvamento deixa ele terminar e então sai com 130.
- Dentro do `$EDITOR`, o Ctrl+C é do editor. Um que o ignora (o Vim saindo do modo de inserção) não faz nenhuma das coisas acima; um que o Ctrl+C mata encerra a revisão e salva, como o primeiro Ctrl+C.

### `move`

    llm-tests-forge move --scenario <antigo> <novo>
    llm-tests-forge move --case <id> --to <cenário>

Renomeia um cenário ou move um caso para outro cenário, reescrevendo o que os ids nomeiam: o arquivo de casos do cenário, cada id de caso numerado a partir dele, os ponteiros `duplicate_of` e o `suite.include`.
- Um caso movido é numerado depois do último caso do destino.
- Quando o oráculo do destino não aceita o esperado dele, o caso volta a pendente e a linha diz por quê.
- O destino é escrito antes de a origem ser tocada, então uma falha no meio deixa uma duplicata para limpar, nunca um caso sumido.

No final, `.forge/` guarda `feature.yaml`, `scenarios.yaml` e `cases/<scenario>.yaml`: YAML simples, feito para ser commitado e comparado em diff como qualquer outra fixture de teste.
