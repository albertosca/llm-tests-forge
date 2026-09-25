# What a copied application page looks like

Reference for writing or reviewing cases of this suite. It describes a real application form (an Ashby-hosted job page, 2026-09-22) as the candidate got it with Ctrl+A then Ctrl+C in a desktop browser. The page itself is not kept; only its shape is.

## Shape of the text

- **No markup and no bracketed placeholders.** What arrives is the rendered text, never HTML and never `[text field]`.
- **An empty text field shows up as its placeholder**, on the line after the label: `Type here...`, `hello@example.com...`, `1-415-555-1234...`, `https://example.com...`. The trailing `...` is part of the copied text.
- **A searchable dropdown or combobox shows up as `Start typing...`**, with none of its options. The options only exist after the candidate types.
- **Radio buttons and checkbox groups show up as their option labels on bare lines**, one per line, no marker: `Yes` / `No`, or `1-2 weeks` / `3-4 weeks` / `1 month` / `2 months` / `3+ months`, sometimes with blank lines between them.
- **A file field shows up as the browser's own words, in the browser's language**: `Nenhum arquivo escolhido` on a Portuguese-language browser, followed by `Upload File` and `or drag and drop here`.
- **Consent checkboxes show up as their statement followed by `I agree`**. A confirmation can also be just the statement, with no `I agree` line.
- **Required markers are absent.** No asterisk, no "(required)", so `required` cannot be read from the page.
- **Labels can carry trailing spaces** (`Preferred First Name `) and span several lines, a question followed by a bullet list of what to include, then the placeholder.
- **Noise sits between the questions**: an "Autofill from resume / Upload your resume here" banner at the top, section headings that are not questions ("Outside Work and Advisory Disclosure"), helper text under a question ("Used only to assess eligibility..."), long company-culture paragraphs, links ("Recruiting Privacy Policy"), the submit button ("Submit Application") and a footer notice.

## Size and mix

About 33 questions: 4 contact fields (name, email, phone, a URL), 1 file, 6 comboboxes (country, location, citizenship, job level, clearance, referral source), about 10 open questions (reasons for leaving, a structured achievement question, timeline, working hours, compensation, visa details), about 10 Yes/No radios, 2 radios with more options (notice period, remote experience), and 3 consent statements.

## Judgement calls this shape forces

- **Combobox with no options:** the model may call it `single_select`, but the application turns a choice kind with no options into `long_text` (`_kind` in `pasted.py`), so `long_text` is what the function returns.
- **Yes/No radio:** `single_select` with options `Yes` and `No`, or `boolean`. The prompt does not say.
- **Consent statements:** questions (`boolean`) or legal notice to ignore. The prompt does not say.
- **A multi-line label:** the first line only, or the question with its bullets.
