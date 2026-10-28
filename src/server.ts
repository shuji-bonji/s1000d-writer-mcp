/**
 * s1000d-writer-mcp の組み立て。index.ts は起動だけを担い、テストからはこの関数を直接叩く。
 */
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import {
  CommentInputError,
  CsdbWriteConflictError,
  DraftInputError,
  SegmentsError,
  SkeletonMismatchError,
} from '@shuji-bonji/s1000d-core';
import { ENV, PACKAGE_INFO } from './config.js';
import { tools } from './tools/definitions.js';
import { toolHandlers } from './tools/handlers.js';

/**
 * `initialize` の応答としてクライアントへ返す説明。README やツール説明より早く読まれる。
 *
 * 潰したい誤解:
 * 1. LLM が XML を書いて渡せると読まれること。入力は構造化された木で、XML はサーバーが組み立てる。
 * 2. 修正を自由な値で行えると読まれること。候補の外の値は適用されず rejected になる。
 * 3. 既定で CSDB に書き込むと読まれること。write: true のときだけ書く。
 * 4. 「verification が valid」を S1000D 準拠と読まれること。準拠は判定しない。
 * 5. 翻訳や訳の採点までするように読まれること。文を出し入れするだけ。
 */
const INSTRUCTIONS = `This server WRITES S1000D data modules without letting you write XML. You give a structured draft (titles, paragraphs, steps, tables, figures, references as a tree); the server numbers it (DMC, ICN, PMC, BREX reference), builds the XML, verifies it (XSD, BREX, references) and offers fixes. Every response carries "verification" (VerificationStatus) and ends with "_notes".

It does NOT do the following:
- It does not accept XML that you wrote. build_data_module and convert_manual take a structured draft or a manual (JSON). apply_fixes, extract_segments and apply_segments take an EXISTING document (path or xml), never one you composed. Do not make up DMCs, ICNs, the BREX reference or enumeration values: leave them to the allocation rules.
- It does not fix with values of your own. apply_fixes applies a selection only if it matches a candidate the server computes itself (the Fix.location and ONE of the candidates of s1000d-verify-mcp suggest_fixes or of this server's fixes[]). A value outside the candidates, or outside a range / pattern candidate, is not applied and comes back in rejected[]. "confidence: none" means: ask the user.
- It does not skip verification. XML is verified before it is returned, and the response says how far (schema-not-found and not-run are NOT "valid"). Only fixes with confidence "exact" (one candidate with a definite value) are applied automatically, up to maxFixRounds times, and they are listed in appliedFixes.
- It does not write to the CSDB unless write is true; then it writes into the FIRST folder of csdbDirs / ${ENV.csdbDirs}, never over an existing file unless overwrite is true, and not when the XML is invalid against the XSD unless allowInvalid is true. Without write the XML is only returned.
- It does not decide S1000D conformance and does not interpret severity or enumerations (commentPriorityCode, commentType, issueType, securityClassification are written as given). Explaining BREX rules is s1000d-brex-mcp, verifying and suggesting fixes in detail is s1000d-verify-mcp, reading is s1000d-reader-mcp.
- It does not translate and does not score translations. extract_segments hands out sentences with {n} placeholders and a skeletonHash; apply_segments puts the translated sentences back. Translating and scoring are yours (and other tools').
- It does not make figures and has no STE (ASD-STE100) dictionary. Figures are ICN references to original files you name; the terminology list is the user's.
- It does not ship any S1000D specification, XSD, default BREX or sample. XSD validation and the default BREX need ${ENV.specDir} (the extracted S1000D distribution) or {"specDir": "/absolute/path"} in ~/.config/s1000d-stack/config.json (for hosts that do not pass environment variables to plugins); the CSDB is found via ${ENV.csdbDirs}, "csdbDirs" in that config file, or the "csdbDirs" argument.

The server keeps no state. The numbering ledger (sourceId → DMC, assetId → ICN) comes in with allocation.ledger and goes out in the response: pass it back so the same sourceId always gets the same DMC. The info codes (allocation.rules.infoCodeByKind) have no default; ask the user, because their meaning is the project's decision.

A draft the server cannot build comes back as {"error": {"code": "input-error", "path": "/body[2]/children[1]", "detail": "..."}} (not as a tool failure): fix that spot and call again. Other expected stops are "skeleton-mismatch" (the data module changed since extract_segments) and "write-conflict".

Costs: convert_manual builds and verifies every data module (about 0.1 s each with BREX); use topics to convert a part. Use includeXml: false to keep responses small.`;

/** 呼び出し側が直せる、想定内の失敗。isError にせず、構造化して返す */
function expectedError(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof DraftInputError || error instanceof CommentInputError) {
    return { code: 'input-error', path: error.path, detail: error.detail };
  }
  if (error instanceof SkeletonMismatchError) {
    return {
      code: error.code,
      expected: error.expected,
      actual: error.actual,
      detail: error.message,
    };
  }
  if (error instanceof SegmentsError) {
    return { code: error.code, detail: error.message };
  }
  if (error instanceof CsdbWriteConflictError) {
    return { code: error.code, path: error.path, detail: error.message };
  }
  return undefined;
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: PACKAGE_INFO.name, version: PACKAGE_INFO.version },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of tools) {
    const handler = toolHandlers[tool.name];
    if (!handler) throw new Error(`No handler registered for tool: ${tool.name}`);
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
      },
      async (args) => {
        try {
          const result = await handler(args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const expected = expectedError(error);
          if (expected) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(
                    { error: expected, _notes: ['Nothing was written.'] },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: message }, null, 2) }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}
