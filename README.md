# @shuji-bonji/s1000d-writer-mcp

**English** | [日本語](./README.ja.md)

An MCP server that lets an LLM create S1000D® data modules without writing XML. The LLM passes a structured draft and numbering rules; the server builds the XML, verifies it against the XSD, the BREX and the references, and applies automatically only the fixes that have exactly one candidate (`exact`). A fix with several candidates is applied only from a selection, and a value outside the candidates is never accepted. By default nothing is written.

> [!IMPORTANT]
> This is a personal project and is not affiliated with ASD (Aerospace, Security and Defence Industries Association of Europe). S1000D® is a registered trademark of ASD.
> The S1000D specification, XML schemas, default BREX and official samples are not included in any package or repository, because their terms of use do not grant redistribution. Obtain them from [s1000d.org](https://s1000d.org/) and point the `S1000D_SPEC_DIR` environment variable at the extracted folder.

## What it does

| Tool | Description |
|---|---|
| `build_data_module` | Builds a data module from one draft (descript, proced, process, fault or PM) and numbering rules. The DMC, ICN and issue come from the ledger (`ledger`) and the CSDB, and the same `sourceId` always gets the same DMC. After building, it verifies the XSD, BREX and references, and applies only `exact` fixes, up to `maxFixRounds` rounds. The remaining fixes are returned in `fixes[]` with their candidates |
| `convert_manual` | Converts an experiential manual ([`@shuji-bonji/experiential-manual-model`](https://www.npmjs.com/package/@shuji-bonji/experiential-manual-model)) into one data module per topic plus a publication module. Descriptions, procedures and fault isolation map directly; a screen flow becomes one process data module plus one procedure per screen. References between DMs, the PM and ICNs are resolved on top of the CSDB overlaid with the DMs just built and the ICN originals found on disk. What the conversion cannot represent is returned in `notRepresented` as counts |
| `apply_fixes` | Applies the fixes you chose from the candidates in `fixes[]`. A selection must be a copy of a candidate; a value outside the candidates, or one that does not fit a range, goes to `rejected` with a reason. It re-verifies after applying |
| `create_comment` | Builds a comment data module (`comment`) and verifies it. The sequence number is the next one in the CSDB |
| `extract_segments` | Takes the sentences a person reads out of a data module (titles, paragraphs, steps, warnings, table cells, figure captions) so they can be translated. Inline elements are replaced by `{1}`, `{2}` placeholders, and `skeletonHash` is returned |
| `apply_segments` | Puts translated sentences back into the data module they were taken from. The DMC stays the same and only the language changes. It stops with `skeleton-mismatch` when the data module changed after extraction |

### Write rules

- **Nothing is written by default.** Only with `write: true` does the server write `DMC-….XML` into the first folder of `csdbDirs` (or the first of `S1000D_CSDB_DIR`). With no destination it writes nothing and returns the reason (`no-csdb-dir`).
- A file with the same name is not overwritten (`write-conflict`) unless `overwrite: true` is passed.
- XML that violates the XSD is not written (`schema-invalid`) unless `allowInvalid: true` is passed. `schema-not-found` (no XSD available) is not a violation; the file is written as unverified.
- With `write: true`, `convert_manual` also copies the original assets under their ICN file names.

### What is fixed automatically

Only a fix whose `confidence` is `exact` and which has exactly one candidate is applied (for example, replacing a value when the BREX allows a single responsible company, or removing an element the BREX forbids). `several` (more than one candidate, or a value given as a range) and `none` are not applied and are returned in `fixes[]`. The user chooses, and the server never fixes with a value outside the candidates. Each applied fix is returned in `appliedFixes[]` with the values before and after.

### Verification status (`verification`)

Every response carries the verification status of the XSD, the BREX and the references. A missing XSD is reported as `schema-not-found` and a skipped step as `not-run`; neither is `valid`. The server reports the result of verification only: it does not judge conformance to S1000D and does not interpret severity.

### Input errors

A mistake in the draft or the numbering rules is returned not as `isError` but as `error: { code: "input-error", path, detail }`. `path` is the location of the mistake (for example `/body[1]` or `/allocation/rules/infoCodeByKind/proced`). Fix it and call again.

## What it does not do

> [!WARNING]
> - **It does not accept XML written by an LLM.** It builds only from a draft. The tools that take existing XML (`apply_fixes`, `extract_segments`, `apply_segments`) do not change the structure of the document.
> - **It does not fix with a value outside the candidates.** There is no entry point for writing a free value.
> - **It does not skip verification.** A built XML is always verified before it is returned.
> - **It does not judge conformance to S1000D or interpret severity.** Read the violations in `s1000d-verify-mcp` and the explanation of BREX rules in `s1000d-brex-mcp`.
> - **It does not translate.** It only takes sentences out and puts them back. The LLM or a person translates.
> - **It does not create illustrations or judge Simplified Technical English (STE).** For an illustration it only allocates an ICN and inserts the reference.
> - What a data module cannot represent, such as hotspot coordinates or part of `scopeRefs` in an experiential manual, is reported in `notRepresented` and never dropped silently.
> - It does not create an ACT, CCT or PCT. Applicability relies on the `applic` of the draft and an existing applicability repository.

## Configuration

| Environment variable | Meaning |
|---|---|
| `S1000D_SPEC_DIR` | The folder where you extracted the S1000D distribution you obtained. The XSDs (`xml_schema_flat/`) and the default BREX are searched under it |
| `S1000D_CSDB_DIR` | The folder holding the project's data modules. Several can be given, separated by `:` (`;` on Windows). The BREX chain, reference targets and existing issues are searched here, and the first folder is the write destination |

You can also add folders with the tool argument `csdbDirs` (the first one is the write destination).

### Config file (when environment variables are not passed, such as a Claude Desktop plugin)

When `S1000D_SPEC_DIR` / `S1000D_CSDB_DIR` are not set, the server reads the config file `~/.config/s1000d-stack/config.json` (under `XDG_CONFIG_HOME` if set; the location can be changed with `S1000D_CONFIG`). Claude Desktop does not pass environment variables to a server installed as a plugin, so write the settings here in that case.

```json
{
  "specDir": "/path/to/s1000d/issue-7",
  "csdbDirs": ["/path/to/your/csdb"]
}
```

Environment variables take precedence when they are set. The config file is read again on every call.

### Example configuration for Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "s1000d-writer": {
      "command": "npx",
      "args": ["-y", "@shuji-bonji/s1000d-writer-mcp"],
      "env": {
        "S1000D_SPEC_DIR": "/path/to/s1000d/issue-7",
        "S1000D_CSDB_DIR": "/path/to/your/csdb"
      }
    }
  }
}
```

### Running over HTTP (embedding in a product)

The default is stdio. With `--http` the server starts over Streamable HTTP.

```sh
npx -y @shuji-bonji/s1000d-writer-mcp --http                      # http://127.0.0.1:3000/mcp
npx -y @shuji-bonji/s1000d-writer-mcp --http --port 3102 --path /writer
```

| Argument | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | Address to bind to |
| `--port` | `3000` | Port; `0` picks a free port |
| `--path` | `/mcp` | Path of the MCP endpoint. `GET /healthz` returns the name and version |
| `--allowed-host` | (see below) | Host names allowed in the `Host` header; comma-separated or repeated |
| `--allowed-origin` | (see below) | Host names allowed in the `Origin` header |

When `--host` is a loopback address, `Host` and `Origin` are limited to localhost names (DNS rebinding protection). When bound to any other address they are not checked, so put the server behind the product's reverse proxy or authentication. Because this server can write files, do not expose it without authentication.

## How it works

All building, verification, fixing, comment and segment code lives in the shared library [`@shuji-bonji/s1000d-core`](https://www.npmjs.com/package/@shuji-bonji/s1000d-core); this server holds only the interpretation of arguments, the shape of the responses and the conversion from a manual to drafts (`src/convert/`). The input schemas import the definitions of core's `draft.schema.json`. The conversion is also available as `@shuji-bonji/s1000d-writer-mcp/convert`.

## Development

```sh
npm install
npm test            # runs on self-made test data only (tests/fixtures/)
npm run test:spec   # uses the distribution you obtained (location given by S1000D_SPEC_DIR; default ../../specs/s1000d/issue-7)
npm run build && S1000D_SPEC_DIR=/path/to/issue-7 S1000D_CSDB_DIR=/path/to/csdb npm start   # start over stdio
```

## License

MIT. S1000D® is a registered trademark of ASD. This software is not affiliated with ASD and does not include the specification, schemas or official samples.
