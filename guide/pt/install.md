# Instalação

Um binário pré-compilado, vários jeitos de obtê-lo. A release 0.1.0 está no npm; os outros canais publicam quando seus tokens forem configurados, então até o pacote de um canal aparecer, use o npm, o script ou o clone no fim desta seção.

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

## Verificando um download

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
