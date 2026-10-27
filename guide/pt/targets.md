# Os nove tipos de alvo

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
