🇺🇸 [English](README.md) · 🇧🇷 [Português](README.pt.md)

[![ci](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml) [![lint](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml/badge.svg)](https://github.com/albertosca/llm-tests-forge/actions/workflows/lint.yml) [![coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Falbertosca%2Fllm-tests-forge%2Fbadges%2Fcoverage.json)](https://github.com/albertosca/llm-tests-forge/actions/workflows/ci.yml)

# llm-tests-forge

Forja suítes de regressão revisadas para as funcionalidades de LLM da sua aplicação, de dentro da sua aplicação.

Você descreve o que uma função faz, e a forja enumera cenários de seis tipos (happy, edge, ambiguous, out-of-scope, adversarial, language), gera casos por cenário já com uma saída esperada, e deixa você revisar cada um deles em arquivos simples, um por um. Depois ela calcula o preço da rodada antes de você gastar, gera uma config para o [promptfoo](https://promptfoo.dev) executar contra o seu código de verdade, e transforma a saída do promptfoo de volta em um relatório com tabela por cenário, casos instáveis e custo real contra o estimado.

Duas suítes prontas, geradas e revisadas contra uma aplicação real: [`examples/moonlighter-classify-email/`](examples/moonlighter-classify-email/) e [`examples/moonlighter-extract-questions/`](examples/moonlighter-extract-questions/).

## Instalação

Cada canal abaixo instala o mesmo binário pré-compilado `llm-tests-forge`, então a forja em si não precisa de bun. Nenhum deles está publicado ainda, então hoje o único caminho que funciona é compilar a partir de um clone, mais abaixo.

Escolha o que combina com o seu projeto:

    npm i -D llm-tests-forge                # JavaScript / TypeScript
    uv add --dev llm-tests-forge            # Python
    brew install albertosca/tap/llm-tests-forge   # qualquer projeto; o caminho para Rust e Go
    curl -fsSL https://github.com/albertosca/llm-tests-forge/releases/latest/download/install.sh | sh   # qualquer projeto; o caminho para Rust e Go

Para Elixir, adicione a dependência ao `mix.exs` e depois baixe o binário:

    {:llm_tests_forge, "~> 0.1"}
    mix deps.get
    mix llm_tests_forge.install

Para Ruby, adicione esta linha ao `Gemfile` e rode `bundle install`:

    gem "llm-tests-forge", group: :development

Projetos Rust e Go não têm pacote próprio: use o Homebrew ou o script. O `install.sh` coloca o binário em `~/.local/bin` por padrão e confere o SHA256 antes; `--dir <bin-directory>` escolhe outro diretório e `--version vX.Y.Z` fixa uma versão. No Elixir, um `review` interativo roda como `_build/llm-tests-forge review`, porque `mix llm_tests_forge review` recusa (sai com código 2).

A partir de um clone, que funciona hoje, requer o [bun](https://bun.sh) 1.4 ou mais recente:

    git clone https://github.com/albertosca/llm-tests-forge.git
    cd llm-tests-forge
    bun install
    bun link      # liga o `llm-tests-forge` ao diretório bin global do bun

O `bun link` coloca o comando no diretório bin global do bun, `~/.bun/bin` por padrão, que precisa estar no seu `PATH` (o bun instalado pelo Homebrew não o acrescenta).

A forja não traz um alias curto próprio. Se quiser um, `alias ltf=llm-tests-forge` no seu shell é escolha sua.

Rodar uma suíte precisa do promptfoo, que é Node: a forja em si não precisa, e nunca roda o promptfoo por você.

## Use em um projeto

Rode estes comandos de dentro do projeto cuja funcionalidade de LLM você está testando.

    llm-tests-forge init

Detecta a linguagem do projeto, escreve o `forge.yaml` na raiz e adiciona ao `AGENTS.md` um bloco sobre a forja (criando o arquivo se não houver). `--language` sobrescreve a detecção. Num projeto que já tem `forge.yaml`, o `init` o deixa intocado e só atualiza o bloco do `AGENTS.md`, então `--language` não faz nada ali. O `forge.yaml` lista as suítes e guarda os padrões; ele nasce com `suites: []` e os padrões comentados, e o `describe` acrescenta cada suíte nova à lista. Uma suíte que já existia (copiada de outro lugar, ou criada antes do `init`) não é acrescentada por nenhum verbo: escreva o caminho dela em `suites:` você mesmo (por exemplo `suites: [evals/classify]`). Um já preenchido fica assim:

    # forge.yaml
    version: 1
    language: python
    suites: [evals/classify_response]
    defaults:
      drafter: anthropic/claude-sonnet-5
      target_models: [anthropic/claude-haiku-4-5]
      judges: [anthropic/claude-sonnet-5]

Há uma suíte por função testada, por convenção em `evals/<função>/`, cada uma um diretório com um `.forge/` dentro.

    llm-tests-forge status

Uma linha por suíte registrada: a funcionalidade (marcada `(feature pending)` enquanto espera revisão), os cenários e os casos como aprovados e pendentes (cenários rejeitados aparecem à parte, nunca nessas contagens), a última rodada e qualquer aviso de versão. `status --json` imprime o mesmo para um programa, com `featureStatus` e `scenarios: { approved, pending, rejected }`. É assim que uma pessoa, ou um agente sem histórico de conversa, descobre o que existe e o que está pendente.

    llm-tests-forge guide

Imprime o manual para um agente que opera a forja, embutido no binário instalado e por isso sempre igual à versão instalada. `--suite <caminho>` (um caminho relativo à raiz do projeto) roda qualquer verbo numa suíte registrada de qualquer ponto dentro do projeto; sem ele, o verbo usa a suíte do diretório atual. Um diretório com `.forge/` e sem `forge.yaml` acima continua funcionando como suíte avulsa.

### O drafter

O drafter é o modelo que escreve a funcionalidade, os cenários e os casos; tudo o que ele escreve chega pendente. Defina-o com `--drafter provider/model`, senão `FORGE_DRAFTER`, senão `defaults.drafter` no `forge.yaml`. As chaves vêm primeiro do ambiente, e `~/.config/<provider>/api.env` é o plano B.

| Provedor | Variável de ambiente | Exemplo |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5` |
| `google` | `GOOGLE_API_KEY` | `google/gemini-3.5-flash` |
| `openai` | `OPENAI_API_KEY` | `openai/gpt-5` |
| `ollama` | nenhuma (local) | `ollama/llama3` |
| `fake` | nenhuma | `fake/path/to/responses.json`, para testes |

### O pipeline, uma suíte

Crie o diretório da suíte, entre nele e rode estes comandos nesta ordem.

    mkdir -p evals/classify_response && cd evals/classify_response
    export FORGE_DRAFTER=google/gemini-3.5-flash
    llm-tests-forge describe "The bot classifies hiring emails into rejection, acknowledgement, interview, screening, offer, info_request or unrelated" --prompt-file ../../src/prompt.txt

Escreve `.forge/feature.yaml` como uma descrição estruturada e pendente da funcionalidade (propósito, entradas, formato da saída, invariantes). `--prompt-file` é opcional; passe-o quando a função tiver um system prompt real que valha a pena copiar regras dele (o caminho é relativo a onde você roda o comando, daí o `../../` a partir de `evals/classify_response`). Rodar `describe` de novo por cima de uma funcionalidade que você já revisou é recusado, porque sobrescreveria as invariantes que você escreveu à mão; passe `--force` quando substituir for exatamente o que você quer. Quando ainda não existe `suite.yaml`, a linguagem do projeto não é `other` e o `forge.yaml` define `defaults.target_models` e `defaults.judges`, o `describe` também escreve um `suite.yaml` inicial.

    llm-tests-forge review

Abre uma revisão interativa do que estiver pendente — aqui, a funcionalidade. Aprove, edite ou rejeite; a aprovação libera o próximo passo.

    llm-tests-forge scenarios

Gera `.forge/scenarios.yaml`: um conjunto de cenários cobrindo os seis tipos para a funcionalidade aprovada. `--more <n>` gera mais depois.

    llm-tests-forge review --only scenarios

Revisa os cenários pendentes, um por um.

    llm-tests-forge cases --n 5

Gera 5 casos pendentes por cenário aprovado em `.forge/cases/<scenario-id>.yaml`, cada um com uma saída esperada calculada a partir do formato de oráculo da funcionalidade (label, fields ou rubric). `--scenario <id>` gera casos só para um cenário.

    llm-tests-forge dedupe

Marca casos provavelmente duplicados dentro de cada cenário (`duplicate_of`), sem removê-los. Ele só mexe em casos pendentes, por isso vem antes da revisão dos casos.

    llm-tests-forge import ../../logs/real-inputs.jsonl

Lê um objeto JSON `{"input-name": "value"}` por linha a partir de logs reais de produção e os adiciona como casos pendentes no cenário `imported`, sem saída esperada — você fornece isso durante a revisão.

    llm-tests-forge review

Revisa tudo que ainda está pendente: casos (confirmando ou corrigindo a saída esperada) e qualquer caso importado (definindo sua saída esperada pela primeira vez). Duas coisas a revisão não muda para você: o `id` de um cenário e o campo `scenario` de um caso, porque os dois nomeiam o arquivo onde os casos moram (`.forge/cases/<scenario>.yaml`) — a recusa diz qual chamada de `llm-tests-forge move` faz isso. E editar o `oracle` de um cenário reabre os casos aprovados daquele cenário cujo esperado o novo oráculo não aceita mais: cada um precisa então de `edit` para ganhar um esperado no novo formato, não de `approve`. Um Ctrl+C durante a revisão salva o que já foi decidido; um segundo aborta sem escrever nada, se chegar antes de o salvamento terminar.

    llm-tests-forge move --scenario <antigo> <novo>
    llm-tests-forge move --case <id> --to <cenário>

Renomeia um cenário ou move um caso para outro cenário, reescrevendo o que os ids nomeiam: o arquivo de casos do cenário, cada id de caso numerado a partir dele, os ponteiros `duplicate_of` e o `suite.include`. Um caso movido é numerado depois do último caso do destino; quando o oráculo do destino não aceita o esperado dele, o caso volta a pendente e a linha diz por quê. O destino é escrito antes de a origem ser tocada, então uma falha no meio deixa uma duplicata para limpar, nunca um caso sumido.

No final, `.forge/` guarda `feature.yaml`, `scenarios.yaml` e `cases/<scenario>.yaml` — YAML simples, feito para ser commitado e comparado em diff como qualquer outra fixture de teste.

Os verbos restantes transformam essa suíte em uma rodada. Eles leem o `.forge/suite.yaml`, que o `describe` pode ter começado para você e que, fora isso, você escreve à mão: contra o que a suíte roda, quais modelos julgam um caso `rubric`, e quantas vezes cada caso se repete.

    # .forge/suite.yaml
    target:
      kind: python
      entry: forge_target.py          # opcional: o shim, quando não é o nome padrão
      python: .venv/bin/python        # um interpretador que consiga importar a sua aplicação
      models: [anthropic/claude-haiku-4-5]
    judges: [anthropic/claude-sonnet-5]
    repeat: 2
    include: []                       # vazio = todos os cenários aprovados

`target.kind` é um dos nove tipos abaixo; `kind: promptfoo-python`, que suítes antigas carregam, continua sendo lido como `python`. As chaves específicas de cada tipo são `target.python` (python), `target.command` (exec) e `target.url`, `target.method`, `target.headers`, `target.body` e `target.response` (http).

    llm-tests-forge estimate

Calcula o preço da rodada antes de você gastar: casos × modelos alvo × `repeat`, mais uma chamada de juiz por caso `rubric` por juiz, modelo alvo e `repeat`, contra o `prices.yaml` (que é seu para editar — a saída imprime a data que ele carrega e marca com `~` qualquer modelo que teve de ser precificado pelo irmão mais próximo da lista). Um modelo cujo provedor não tem nenhuma linha na tabela não é precificado de jeito nenhum: a linha dele mostra `not priced`, e o total o deixa de fora dizendo quantas linhas ficaram de fora. Os tokens são contados como caracteres ÷ 4, então leia o número como ordem de grandeza. Não faz nenhuma chamada de API.

    llm-tests-forge emit

Escreve o `.forge/promptfooconfig.yaml` a partir dos casos aprovados: um teste por caso com as entradas como `vars`, um assert `javascript` para o oráculo `label` ou `fields`, e um `llm-rubric` por juiz no caso de `rubric`. Recusa-se a gerar enquanto houver qualquer coisa pendente, e diz o quê. Na primeira vez também escreve o shim da sua linguagem, uma vez só e nunca mais sobrescrito — **preencha a função que ele nomeia para chamar a sua aplicação**, que é o que faz a suíte testar o seu código em vez de uma cópia do seu prompt. Com `--format jsonl`, escreve a mesma seleção em `.forge/cases.jsonl`, para um executor seu.

    npx promptfoo@0.123.0 eval -c .forge/promptfooconfig.yaml -o results.json

O promptfoo roda a suíte a partir do diretório da suíte (`bunx` também serve); a forja não roda por você. O promptfoo sai com status 100 quando algum teste falha: isso é um resultado, não uma queda.

    llm-tests-forge report results.json [--baseline .forge/report.json]

Lê a saída do promptfoo para `.forge/report.md` e `.forge/report.json`: taxa de acerto, tabela por cenário, quais cenários revisados não têm caso, não tiveram rodada casada ou não estão nesta suíte, casos que passaram em uma repetição e falharam em outra, juízes que discordaram (com as duas justificativas) e custo real contra o estimado. Com `--baseline`, um `report.json` anterior é comparado e as regressões vêm primeiro; pares que a baseline tem e esta rodada não (depois de um rename, por exemplo) são nomeados em vez de sumirem do diff em silêncio; um `--baseline` escrito por uma versão mais antiga da forja é aceito, inclusive as chaves que ela escrevia com outro nome.

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

O que um comando `exec` recebe: o promptfoo o roda a partir de `.forge/`, uma vez por caso e por modelo-alvo, com três argumentos — o prompt renderizado (a primeira entrada da funcionalidade), as opções do provider em JSON (o modelo fica em `config.model`) e o contexto em JSON (as entradas do caso ficam em `vars`, que também traz chaves do próprio promptfoo começando com `__`, a ignorar). A entrada padrão vem vazia. A resposta vai para a saída padrão e os logs para a saída de erro; uma falha é uma mensagem na saída de erro e um status de saída diferente de zero, que o promptfoo mostra como linha de erro.

No `http`, o próprio `emit` substitui `{{target_model}}`, inclusive em strings aninhadas do `body`, antes de escrever a configuração. Com mais de um `target.models` e nenhum `{{target_model}}`, todo provider manda a mesma requisição, e o `emit` imprime um aviso dizendo isso.

Todo shim do tipo exec responde na stdout, então a sua aplicação precisa logar na stderr. Compile o projeto (`mix compile`, `cargo build`, `go build`) antes da primeira rodada: o promptfoo roda casos em paralelo, e uma primeira compilação disputando consigo mesma não está verificada como segura. Um shim que falha (status de saída diferente de zero, ou um erro que ele devolve) aparece como linha de erro no promptfoo, não como assert falho.

### Agentes

O `init` adiciona ao `AGENTS.md` um bloco que aponta um agente para `llm-tests-forge status` e `llm-tests-forge guide`. A regra desse manual é a que importa: aprovar é trabalho da pessoa, então um agente nunca marca nada como aprovado editando um arquivo e nunca roda o `review` por você.

Uma skill do Claude Code (`plugin/skills/llm-tests-forge/`) é um ponteiro fino para o mesmo manual. O comando de instalação é `/plugin marketplace add albertosca/llm-tests-forge`, e ele funciona quando o repositório for público. Até lá, `/plugin marketplace add <caminho do seu clone>` a instala a partir de um checkout local.

### O que commitar dentro de `.forge/`

Commite o `forge.yaml` e, em cada suíte, `feature.yaml`, `scenarios.yaml`, `cases/<scenario>.yaml`, `suite.yaml`, `promptfooconfig.yaml`, o shim e `report.md`/`report.json`: eles são a suíte revisada, a rodada que ela descreve e o resultado, e o diff deles é justamente o ponto. Coloque no gitignore o `usage.jsonl` e o `failures/`, que guardam contagem de tokens e a saída crua do modelo nas suas rodadas, e decida deliberadamente sobre o `cases/imported.yaml` — o `import` o preenche com entradas reais de produção, que podem ser dados que você não pode colocar num repositório.

### Códigos de saída

| Código | Significa |
|---|---|
| `0` | o verbo fez o que promete |
| `1` | o trabalho falhou: um arquivo que não existe, um modelo que recusou, uma funcionalidade ainda pendente de revisão |
| `2` | a linha de comando é inutilizável: verbo ou opção desconhecida, valor de flag inválido, argumento obrigatório ausente, nenhum modelo configurado |

## O que isso ainda não faz

- Não chama o promptfoo por você: o `llm-tests-forge emit` escreve a config e você roda a avaliação.
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

O gate de cobertura é o do próprio bun: um piso de 1,0 sobre **linhas e funções**, com `src/cli/bin.ts` excluído. O bun não mede cobertura de branch nenhuma, então um arquivo em 100% ainda pode ter braços de guarda sem teste — leia o gate como um piso, não como prova de que a suíte está completa.

O `test:live` precisa de `GOOGLE_API_KEY` e falha de forma explícita (não em silêncio) se ela estiver ausente. O free tier do Google é intermitente, não simplesmente indisponível, então o teste tenta de novo uma resposta 503/"high demand" até 3 vezes com uma pausa curta entre as tentativas; qualquer outra falha (cota, autenticação, um model id desconhecido, um schema que não bate) falha já na primeira ocorrência em vez de tentar de novo.

## Licença

MIT — veja `LICENSE`.
