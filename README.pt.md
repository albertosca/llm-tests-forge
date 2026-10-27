🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![lint](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml) [![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Falbertosca%2Fllm-tests-forge%2Fbadges%2Fcoverage.json)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

# LLM Tests Forge

Suítes de regressão para as funcionalidades de LLM da sua aplicação: rascunhadas por um modelo, aprovadas por você e guardadas como arquivos simples no seu repositório.

![A forja em um terminal: status, a revisão de dois casos, estimate e report](assets/demo.gif)

Você descreve o que uma função faz. A forja enumera cenários de seis tipos (happy, edge, ambiguous, out-of-scope, adversarial, language), rascunha casos para cada um com uma saída esperada, e conduz você na revisão de cada um deles. Calcula o preço da rodada antes de você gastar, gera uma config para o [promptfoo](https://promptfoo.dev) executar contra o seu código de verdade, e lê a saída do promptfoo de volta em um relatório: tabela por cenário, casos instáveis, custo real contra o estimado.

Duas suítes prontas, geradas e revisadas contra uma aplicação real: [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/) e [`examples/moonlighter-extract-questions/`](examples/moonlighter-extract-questions/).

## Como se diferencia, e por quê

Uma funcionalidade de LLM muda de comportamento sempre que o prompt, o modelo ou o código em volta mudam, então o conjunto de avaliação que a protege precisa ser barato de escrever e barato de manter honesto. Quatro escolhas decorrem disso.

As saídas esperadas são arquivos YAML no repositório, ao lado do código que testam, e uma pessoa aprova cada uma. O modelo rascunha; ele nunca decide o que significa "correto". A suíte aparece então nos pull requests como qualquer outra fixture, em vez de morar num serviço ou num dataset que precisa ser mantido em sincronia com o código.

A cobertura se organiza por tipo de cenário, não por volume, de modo que as entradas adversariais e fora de escopo são escritas junto do caminho feliz, e não depois dele.

Uma rodada tem o preço calculado antes de ser gasta, e uma rodada aprovada pode ser selada aos arquivos, modelos e taxa de acerto em que foi conquistada, para o CI conferir offline que nenhum deles mudou.

A execução fica com o promptfoo. A forja decide o que testar e gera a config; ela não traz um executor próprio.

## Instalação

Um binário pré-compilado, vários jeitos de obtê-lo. Nada está publicado ainda, então até a primeira release o único caminho que funciona é o clone, no fim desta seção.

    npm i -D llm-tests-forge                # JavaScript / TypeScript
    uv add --dev llm-tests-forge            # Python
    brew install albertosca/tap/llm-tests-forge   # qualquer projeto
    curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | sh   # qualquer projeto

**Elixir.** Adicione a dependência ao `mix.exs` e depois baixe o binário:

    {:llm_tests_forge, "~> 0.1", only: :dev, runtime: false}
    mix deps.get
    mix llm_tests_forge.install

Um `review` interativo roda como `_build/llm-tests-forge review`, porque `mix llm_tests_forge review` recusa (sai com código 2). `review --scenario <id> --all` não pergunta nada e roda pelo mix.

**Ruby.** Adicione `gem "llm-tests-forge", group: :development` ao `Gemfile` e rode `bundle install`.

**Rust e Go.** Não têm pacote próprio: use o Homebrew ou o script.

**Opções do `install.sh`.**
- Ele grava em `~/.local/bin`; `--dir <bin-directory>` escolhe outro.
- `--version vX.Y.Z` fixa uma versão.
- Pelo pipe, passe as opções depois de `sh -s --`.

**A partir de um clone** (requer o [bun](https://bun.sh) 1.4 ou mais recente):

    git clone https://github.com/albertosca/llm-tests-forge.git
    cd llm-tests-forge
    bun install
    bun link      # coloca o `llm-tests-forge` no diretório bin global do bun, ~/.bun/bin por padrão

Rodar uma suíte precisa do promptfoo, que é Node. A forja em si não precisa, e nunca roda o promptfoo por você.

**Plataformas.**
- Os binários cobrem macOS (arm64, x64), Linux com glibc (x64, arm64) e Windows x64.
- Em qualquer outra plataforma, musl/Alpine incluído, o pip e o gem instalam um pacote reserva sem binário. O comando dele diz isso e sai com código 1, como o do npm e o `install.sh`.
- Numa plataforma suportada, o reserva diz como obter o binário: o `--platform` do pip, o `force_ruby_platform` do Bundler, `bundle lock --add-platform` (para um `Gemfile.lock` cujo `PLATFORMS` não tem esta plataforma) ou `gem install --platform ruby`.

### Verificando um download

O `install.sh` faz duas conferências, e elas provam coisas diferentes.

- **Integridade.** O SHA256 do binário precisa bater com o `SHA256SUMS` da release. Isso prova que o download chegou íntegro, não quem o compilou, já que os dois vêm do mesmo lugar. O Homebrew e o Hex, em vez disso, fixam o hash de cada binário no próprio pacote.
- **Proveniência.** Cada binário da release e o `SHA256SUMS` levam uma atestação de artefato do GitHub, assinada via Sigstore pelo workflow de release deste repositório. Com o [`gh`](https://cli.github.com) 2.49 ou mais recente no PATH, o script a verifica, logado ou anonimamente (o GitHub permite 60 requisições anônimas à API por hora por endereço).

O que você vê:
- **A atestação confere:** uma linha diz isso.
- **Não confere:** nada é instalado, e o script mostra o que o `gh` disse e o que verificar.
- **O `gh` não está instalado ou é anterior à 2.49:** o binário é instalado só pelo checksum. O script diz que a proveniência não foi conferida e mostra o comando que a confere depois, que serve para qualquer binário baixado:

      gh attestation verify ~/.local/bin/llm-tests-forge --repo albertosca/llm-tests-forge --signer-workflow albertosca/llm-tests-forge/.github/workflows/release.yml --deny-self-hosted-runners

Dois detalhes que valem saber:
- O `install.sh` sempre pergunta ao github.com, mesmo quando o `GH_HOST` aponta outro host, então um token do GitHub Enterprise em `GH_TOKEN` ou `GITHUB_TOKEN` é recusado ali. Tire-o do ambiente durante a instalação.
- Para instalar só pelo checksum depois de uma recusa, defina `LLM_TESTS_FORGE_PROVENANCE=skip` para o `sh`. O script então diz, com um aviso, que a proveniência não foi conferida. Isso não prova quem compilou o binário.

## Início rápido

De dentro do projeto cuja funcionalidade de LLM você está testando:

    llm-tests-forge init
    llm-tests-forge describe "o que a função faz" --prompt-file caminho/para/prompt.txt
    llm-tests-forge review        # aprove, edite ou rejeite cada cenário e caso
    llm-tests-forge estimate      # quanto uma rodada vai custar, antes de gastar
    llm-tests-forge emit          # a config do promptfoo e um shim para a sua linguagem

`llm-tests-forge guide` imprime o manual para um agente que opera a forja. O passo a passo completo está em [Uso](#uso).

## Uso

O fluxo inteiro, em ordem. Cada passo tem a sua entrada logo abaixo.

1. `init`, uma vez por projeto.
2. `describe` e depois `review`: a forja escreve uma descrição da funcionalidade, e você a aprova.
3. `scenarios` e depois `review --only scenarios`: as situações que a funcionalidade precisa tratar, aprovadas por você.
4. `cases`, depois `dedupe`, opcionalmente `import`, depois `review`: os casos e suas saídas esperadas, aprovados por você.
5. `estimate` e depois `emit`: o preço, e então a config do promptfoo.
6. Rode o promptfoo você mesmo e depois `report`.
7. Opcionalmente, `stamp` depois de uma boa rodada, e `check` no CI.

### Preparando um projeto

Rode estes comandos de dentro do projeto cuja funcionalidade de LLM você está testando.

#### `init`

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

#### `status`

    llm-tests-forge status

Uma linha por suíte registrada, mostrando:
- a funcionalidade, marcada `(feature pending)` enquanto espera revisão;
- os cenários e os casos como aprovados e pendentes (cenários rejeitados aparecem à parte, nunca nessas contagens);
- a última rodada e qualquer aviso de versão.

`status --json` imprime o mesmo para um programa, com `featureStatus` e `scenarios: { approved, pending, rejected }`. É assim que uma pessoa, ou um agente sem histórico de conversa, descobre o que existe e o que está pendente.

#### `guide`

    llm-tests-forge guide

Imprime o manual para um agente que opera a forja. Ele é embutido no binário instalado, por isso sempre igual à versão instalada.

#### Escolhendo a suíte

- `--suite <caminho>` (um caminho relativo à raiz do projeto) roda qualquer verbo numa suíte registrada de qualquer ponto dentro do projeto.
- Sem ele, o verbo usa a suíte do diretório atual.
- Um diretório com `.forge/` e sem `forge.yaml` acima continua funcionando como suíte avulsa.

### O drafter

O drafter é o modelo que escreve a funcionalidade, os cenários e os casos. Tudo o que ele escreve chega pendente.

Defina-o nesta ordem de precedência: `--drafter provider/model`, senão `FORGE_DRAFTER`, senão `defaults.drafter` no `forge.yaml`. As chaves vêm primeiro do ambiente, e `~/.config/<provider>/api.env` é o plano B.

| Provedor | Variável de ambiente | Exemplo |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | nenhuma (local) | `ollama/llama3` |
| `fake` | nenhuma | `fake/path/to/responses.json`, para testes |

### Montando uma suíte

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

#### `describe`

    llm-tests-forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file ../../src/prompt.txt

Escreve `.forge/feature.yaml` como uma descrição estruturada e pendente da funcionalidade: propósito, entradas, formato da saída, invariantes.

- **Os nomes das entradas** viram variáveis de template do promptfoo. Levam letras ASCII, dígitos e sublinhados, começam por letra (um sublinhado inicial é do próprio promptfoo) e não são nenhum de `not`, `true`, `false`, `none`, `null`. Escreva `user_message`, não `user message`. Um `feature.yaml` com qualquer outro nome é recusado.
- **Renomear uma entrada** é renomeá-la no `feature.yaml`, nas chaves de `input:` de todo caso e no código do target ou do shim. Até lá, `estimate`, `emit` e `report` recusam um caso aprovado cujas chaves de entrada não batem com as entradas da funcionalidade.
- **`--prompt-file`** é opcional. Passe-o quando a função tiver um system prompt real que valha a pena copiar regras dele. O caminho é relativo a onde você roda o comando, daí o `../../` a partir de `evals/classify_response`.
- **Rodá-lo de novo** por cima de uma funcionalidade que você já revisou é recusado, porque sobrescreveria as invariantes que você escreveu à mão. Passe `--force` quando substituir for exatamente o que você quer.
- **Ele também escreve um `suite.yaml` inicial** quando as três condições valem: ainda não existe `suite.yaml`, a linguagem do projeto não é `other` e o `forge.yaml` define `defaults.target_models` e `defaults.judges`.

#### `scenarios`

    llm-tests-forge scenarios

Gera `.forge/scenarios.yaml`: um conjunto de cenários cobrindo os seis tipos para a funcionalidade aprovada. `--more <n>` gera mais depois.

#### `cases`

    llm-tests-forge cases --n 5

Gera 5 casos pendentes por cenário aprovado em `.forge/cases/<scenario-id>.yaml`. Cada um tem uma saída esperada calculada a partir do formato de oráculo da funcionalidade (`label`, `fields` ou `rubric`). `--scenario <id>` gera casos só para um cenário.

#### `dedupe`

    llm-tests-forge dedupe

Marca casos provavelmente duplicados dentro de cada cenário (`duplicate_of`), sem removê-los. Ele só mexe em casos pendentes, por isso vem antes da revisão dos casos.

#### `import`

    llm-tests-forge import ../../logs/real-inputs.jsonl

Lê um objeto JSON `{"input-name": "value"}` por linha a partir de logs reais de produção e os adiciona como casos pendentes no cenário `imported`. Eles não têm saída esperada: você a fornece durante a revisão.

#### `review`

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

#### `move`

    llm-tests-forge move --scenario <antigo> <novo>
    llm-tests-forge move --case <id> --to <cenário>

Renomeia um cenário ou move um caso para outro cenário, reescrevendo o que os ids nomeiam: o arquivo de casos do cenário, cada id de caso numerado a partir dele, os ponteiros `duplicate_of` e o `suite.include`.
- Um caso movido é numerado depois do último caso do destino.
- Quando o oráculo do destino não aceita o esperado dele, o caso volta a pendente e a linha diz por quê.
- O destino é escrito antes de a origem ser tocada, então uma falha no meio deixa uma duplicata para limpar, nunca um caso sumido.

No final, `.forge/` guarda `feature.yaml`, `scenarios.yaml` e `cases/<scenario>.yaml`: YAML simples, feito para ser commitado e comparado em diff como qualquer outra fixture de teste.

### Rodando uma suíte

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

- `target.kind` é um dos nove tipos [abaixo](#os-nove-tipos-de-alvo). `kind: promptfoo-python`, que suítes antigas carregam, continua sendo lido como `python`.
- As chaves específicas de cada tipo são `target.python` (python), `target.command` (exec) e `target.url`, `target.method`, `target.headers`, `target.body` e `target.response` (http).

#### `estimate`

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

#### `emit`

    llm-tests-forge emit

Escreve o `.forge/promptfooconfig.yaml` a partir dos casos aprovados:
- um teste por caso, com as entradas como `vars`;
- um assert `javascript` para o oráculo `label` ou `fields`, e um `llm-rubric` por juiz no caso de `rubric`;
- uma recusa, dizendo o quê, enquanto houver qualquer coisa pendente.

Na primeira vez também escreve o shim da sua linguagem, uma vez só e nunca mais sobrescrito. **Preencha a função que ele nomeia para chamar a sua aplicação**: é isso que faz a suíte testar o seu código em vez de uma cópia do seu prompt.

Com `--format jsonl`, escreve a mesma seleção em `.forge/cases.jsonl`, para um executor seu.

#### Rode o promptfoo

    npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

O promptfoo roda a suíte a partir do diretório da suíte (`bunx` também serve). A forja não roda por você. O promptfoo sai com status 100 quando algum teste falha: isso é um resultado, não uma queda.

#### `report`

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

#### `stamp` e `check`

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

### Os nove tipos de alvo

O shim mora em `.forge/<entry>`, com os nomes padrão abaixo a menos que `target.entry` o renomeie. O `emit` o escreve uma vez e nunca o sobrescreve; você preenche a única função que ele nomeia.

| `target.kind` | O que o `emit` escreve | O que você preenche |
|---|---|---|
| `python` | `forge_target.py` | `run_application`; `target.python` define o interpretador que o promptfoo roda, e ele precisa conseguir importar o seu código |
| `javascript` | `forge_target.mjs` | `runApplication` |
| `typescript` | `forge_target.ts`, que o promptfoo carrega direto | `runApplication` |
| `elixir` | `forge_target.exs`, rodado por `mix run` a partir do projeto mix (Elixir 1.18 ou mais recente, por causa do JSON) | `run_application/2`; rode `mix compile` antes da primeira rodada |
| `ruby` | `forge_target.rb` | `run_application` |
| `rust` | o crate `forge_target/` (`Cargo.toml`, `src/main.rs`) | descomente a dependência do seu crate, preencha `run_application` e compile uma vez com `cargo build --release` dentro de `.forge/forge_target/` |
| `go` | o módulo `forge_target/` (`go.mod`, `main.go`) | descomente as linhas `require` e `replace`, preencha `runApplication` e compile uma vez com `GOWORK=off go build -o forge_target .` dentro de `.forge/forge_target/` |
| `exec` | nada | `target.command` no `suite.yaml` nomeia o programa; ele roda a partir de `.forge/`, então um comando relativo é relativo a `.forge/` |
| `http` | nada | `target.url`, e opcionalmente `method`, `headers`, `body` (cada entrada da funcionalidade está disponível como `{{<nome da entrada>}}`; o corpo padrão é uma chave por entrada) e `response` (uma expressão sobre `json`, sem `=>`); o `emit` troca `{{target_model}}` em `url`, num valor de header ou no `body` pelo modelo de cada provider |

**O que um comando `exec` recebe.** O promptfoo o roda a partir de `.forge/`, uma vez por caso e por modelo-alvo, com três argumentos:
1. o prompt renderizado (a primeira entrada da funcionalidade);
2. as opções do provider em JSON (o modelo fica em `config.model`);
3. o contexto em JSON (as entradas do caso ficam em `vars`, que também traz chaves do próprio promptfoo começando com `__`, a ignorar).

A entrada padrão vem vazia. A resposta vai para a saída padrão e os logs para a saída de erro. Uma falha é uma mensagem na saída de erro e um status de saída diferente de zero, que o promptfoo mostra como linha de erro.

**No `http`**, o próprio `emit` substitui `{{target_model}}`, inclusive em strings aninhadas do `body`, antes de escrever a configuração. Com mais de um `target.models` e nenhum `{{target_model}}`, todo provider manda a mesma requisição, e o `emit` imprime um aviso dizendo isso.

**Para todo shim do tipo exec:**
- Ele responde na stdout, então a sua aplicação precisa logar na stderr.
- Compile o projeto (`mix compile`, `cargo build`, `go build`) antes da primeira rodada. O promptfoo roda casos em paralelo, e uma primeira compilação disputando consigo mesma não está verificada como segura.
- Um shim que falha (status de saída diferente de zero, ou um erro que ele devolve) aparece como linha de erro no promptfoo, não como assert falho.

### Agentes

O `init` adiciona ao `AGENTS.md` um bloco que aponta um agente para `llm-tests-forge status` e `llm-tests-forge guide`. A regra desse manual é a que importa: aprovar é trabalho da pessoa, então um agente nunca marca nada como aprovado editando um arquivo e nunca roda o `review` por você.

Uma skill do Claude Code (`plugin/skills/llm-tests-forge/`) é um ponteiro fino para o mesmo manual. O comando de instalação é `/plugin marketplace add albertosca/llm-tests-forge`, e ele funciona quando o repositório for público. Até lá, `/plugin marketplace add <caminho do seu clone>` a instala a partir de um checkout local.

### O que commitar dentro de `.forge/`

Commite:
- o `forge.yaml`;
- em cada suíte, `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, o shim e `report.md`/`report.json`.

Eles são a suíte revisada, a rodada que ela descreve e o resultado, e o diff deles é justamente o ponto.

Coloque no gitignore o `usage.jsonl` e o `failures/`, que guardam contagem de tokens e a saída crua do modelo nas suas rodadas.

Decida deliberadamente sobre o `cases/imported.yaml`: o `import` o preenche com entradas reais de produção, que podem ser dados que você não pode colocar num repositório.

### Códigos de saída

| Código | Significa |
|---|---|
| `0` | o verbo fez o que promete |
| `1` | o trabalho falhou: um arquivo que não existe, um modelo que recusou, uma funcionalidade ainda pendente de revisão |
| `2` | a linha de comando é inutilizável: verbo ou opção desconhecida, valor de flag inválido, argumento obrigatório ausente, nenhum modelo configurado |

## Limitações

- Não chama o promptfoo por você: o `llm-tests-forge emit` escreve a config e você roda a avaliação.
- O promptfoo é o único emissor hoje.
- Não existe servidor MCP, então o loop de revisão não roda dentro de uma conversa.
- Testa um turno por vez. Casos multi-turno, em que a própria resposta da aplicação molda o turno seguinte, precisam de um usuário simulado, que isto não é.
- Não guarda histórico: o `--baseline` compara duas rodadas, e nada as acumula ao longo do tempo.
- Ainda não está publicado em nenhum registro de pacotes.

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

## Decisões de engenharia

**A forja escreve config; o promptfoo a executa.** Providers, concorrência, cache e o visualizador de resultados são do promptfoo. A forja cuida do que testar e do que significa "correto", e o emissor dela mora em módulo próprio, `src/emit`. O `--format jsonl` entrega a mesma seleção a um executor seu. O custo é ter um emissor só hoje e depender do formato de config do promptfoo.

**Aprovar é um ato humano.** Um item rascunhado fica pendente até uma pessoa decidir sobre ele no `review`. O manual do agente diz que um agente nunca marca nada como aprovado editando um arquivo e nunca roda o `review`, e o `emit` se recusa a escrever enquanto houver qualquer coisa pendente.

**Saídas esperadas são arquivos simples.** YAML dentro de `.forge/`, um arquivo de casos por cenário, de modo que mudar o que significa "correto" é um diff que alguém precisa ler e aprovar.

**Estimativas são faixas.** Nada da resposta real existe antes da rodada, então o `estimate` mostra uma faixa em torno do ponto, calibrada nas poucas rodadas que vêm aqui: um palpite, não um orçamento. Um provedor sem linha de preço fica sem preço e contado como deixado de fora, nunca precificado como outra coisa. A conta está em [`estimate`](#estimate).

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

## Comunidade

Leia o [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir um pull request, relate vulnerabilidades como o [SECURITY.md](SECURITY.md) descreve, e siga o [Código de Conduta](CODE_OF_CONDUCT.md). O que mudou em cada versão está no [changelog](CHANGELOG.md).

## Licença

MIT — veja `LICENSE`.
