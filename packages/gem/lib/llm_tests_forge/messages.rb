# frozen_string_literal: true

# The texts the shim prints when no binary runs here. They live apart from the
# lookup in ../llm_tests_forge.rb, which requires this file, to keep each module
# body under the length RuboCop allows.
module LlmTestsForge
  module_function

  def musl_message(name)
    "llm-tests-forge has no binary for musl/Alpine yet (#{name}-musl): the #{name} binary needs glibc; " \
      "see #{REPOSITORY_URL}"
  end

  FALLBACK_CAUSES = {
    force_ruby_platform: "Bundler's force_ruby_platform chose the fallback. Unset it " \
                         "(bundle config unset force_ruby_platform, or drop force_ruby_platform: true " \
                         "from the Gemfile) and run bundle install",
    lockfile: "Bundler chose the fallback because the PLATFORMS of Gemfile.lock lack this platform. " \
              "Add it: bundle lock --add-platform %<native>s, then bundle install",
    gem_install: "gem install --platform ruby chose the fallback (if Bundler installed it, run it with " \
                 "bundle exec to see why). Reinstall it without --platform ruby: gem install llm-tests-forge"
  }.freeze

  def fallback_chosen_message(name, native, cause)
    "llm-tests-forge: this is the ruby-platform fallback gem, which has no binary, " \
      "but #{name} has a native gem (#{native}); #{format(FALLBACK_CAUSES.fetch(cause), native: native)}"
  end
end
