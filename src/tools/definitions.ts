/**
 * ツール定義（入力スキーマ）。実装は handlers.ts。
 * すべてのツールは additionalProperties: false を持ち、未知の引数は SDK の入力検証で弾かれる。
 * 下書き（draft）・採番の規則（allocation）の形は core の `schema/draft.schema.json` の `$defs` をそのまま取り込む
 * （型と JSON Schema の `required` は core のテストで揃えてある）。
 */
import { createRequire } from 'node:module';
import type { JsonSchemaType, Tool } from '@modelcontextprotocol/server';

export type ToolDefinition = Omit<Tool, 'inputSchema'> & { inputSchema: JsonSchemaType };

const require = createRequire(import.meta.url);
const draftSchema = require('@shuji-bonji/s1000d-core/schema/draft.schema.json') as {
  $defs: Record<string, unknown>;
};

/** core の draft.schema.json の $defs（DraftDataModule・DraftNode・Allocation・DmCode・IssueInfo・Language …） */
const DEFS = draftSchema.$defs as unknown as NonNullable<JsonSchemaType['$defs']>;

/**
 * 引数の位置に $defs の定義を展開して置く（`type: "object"` などをその場に持たせる）。
 *
 * `$ref` だけを置くと、`$ref` を解決しないクライアントが引数の型を決められず、
 * オブジェクトを文字列として渡すことがある（0.1.0 の Claude Desktop の plugin 版で
 * `data/draft must be object` になった）。中の入れ子の `$ref`（DraftNode の再帰など）は
 * 同じ inputSchema の `$defs` を指したまま残す。
 */
const ref = (name: string, description?: string) => {
  const def = (DEFS as Record<string, Record<string, unknown>>)[name];
  if (!def) throw new Error(`draft.schema.json has no $defs/${name}`);
  return { ...def, ...(description ? { description } : {}) };
};

const csdbDirsParam = {
  type: 'array',
  items: { type: 'string' },
  description:
    'CSDB folders used to resolve references, find BREX and number new objects (default: S1000D_CSDB_DIR / the config file). The FIRST folder is also where write: true writes (it may not exist yet). When given, these folders replace S1000D_CSDB_DIR and the csdbDirs of the config file (they are not added to them); other folders that do not exist are skipped and reported in _notes.',
} as const;
const pathParam = { type: 'string', description: 'File path of the document.' } as const;
const xmlParam = {
  type: 'string',
  description:
    'An existing document as an XML string (alternative to path; max 5 MB). Not for XML you wrote yourself: build new data modules with build_data_module.',
} as const;
const productParam = {
  type: 'object',
  description:
    'The product to evaluate applicability for. attributes: ACT productAttribute id → value; conditions: CCT cond id → value. Omit to skip the applicability check.',
  properties: {
    attributes: { type: 'object', additionalProperties: { type: 'string' } },
    conditions: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: false,
} as const;
const writeParam = {
  type: 'boolean',
  description:
    'Write the result into the CSDB (the first folder of csdbDirs / S1000D_CSDB_DIR). Default false: the XML is only returned. Nothing is written when the XML is not valid against the XSD unless allowInvalid is true.',
  default: false,
} as const;
const reasonParam = {
  type: 'object',
  description:
    "One reason for update (reasonForUpdate in the status element). The text and the type are the user's: never fill them in.",
  properties: {
    text: { type: 'string', minLength: 1, description: 'The text of the reason (one simplePara).' },
    updateReasonType: {
      type: 'string',
      pattern: '^urt[0-9]{2}$',
      description:
        'S1000D updateReasonType, written as given: urt01 editorial change (no change markup may refer to it), urt02 technical change, urt03 markup only, urt04 applicability only, urt05 references only; urt51-urt99 are project values. Required: it is never chosen for you.',
    },
    updateHighlight: {
      type: 'string',
      enum: ['0', '1'],
      description: '"1": this reason goes into the Highlights data module.',
    },
    id: {
      type: 'string',
      description:
        'reasonForUpdate/@id. Omit it: an id that is not in the document is made (rfu-0001 …). An id already in the document is refused.',
    },
  },
  required: ['text', 'updateReasonType'],
  additionalProperties: false,
} as const;
const overwriteParam = {
  type: 'boolean',
  description:
    'With write: true, replace a file of the same name. Default false: an existing file is left alone and reported as write-conflict.',
  default: false,
} as const;
const allowInvalidParam = {
  type: 'boolean',
  description:
    'With write: true, write even when verification.schema.state is "invalid". Default false.',
  default: false,
} as const;
const maxFixRoundsParam = {
  type: 'integer',
  minimum: 0,
  maximum: 10,
  description:
    'How many times to apply the fixes the server is certain about (confidence "exact") and verify again (default 3). 0 turns automatic fixing off.',
  default: 3,
} as const;
const maxFixesParam = {
  type: 'integer',
  minimum: 1,
  maximum: 1000,
  description: 'Cap on the remaining fixes listed in the response (default 50).',
  default: 50,
} as const;
const issuePolicyParam = {
  type: 'string',
  enum: ['increment-issue', 'increment-inwork', 'keep'],
  description:
    'When the CSDB already has the same data module and the draft gives no issueInfo: raise issueNumber (default), raise inWork, or keep the issue.',
  default: 'increment-issue',
} as const;
const assetFormatsParam = {
  type: 'object',
  description:
    'File format of each figure original, by assetId (or ICN): { extension: "PNG", notation: "png", publicId? }. Default: taken from the original file name for known formats (png, jpg, gif, svg, cgm, pdf).',
  additionalProperties: {
    type: 'object',
    properties: {
      extension: { type: 'string' },
      notation: { type: 'string' },
      publicId: { type: 'string' },
    },
    required: ['extension', 'notation'],
    additionalProperties: false,
  },
} as const;

const commentRefSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['dmRef', 'pmRef', 'dmlRef', 'ddnRef'] },
    code: {
      type: 'string',
      description: 'DMC, PMC, DML code or DDN code of the target ("DMC-" etc. prefix optional).',
    },
    issueInfo: ref('IssueInfo'),
    language: ref('Language'),
  },
  required: ['kind', 'code'],
  additionalProperties: false,
} as const;

const addressSchema = {
  type: 'object',
  description: 'city and country are required by comment.xsd.',
  properties: {
    city: { type: 'string' },
    country: { type: 'string' },
    department: { type: 'string' },
    street: { type: 'string' },
    postOfficeBox: { type: 'string' },
    postalZipCode: { type: 'string' },
    state: { type: 'string' },
    province: { type: 'string' },
    building: { type: 'string' },
    room: { type: 'string' },
    phoneNumber: { type: 'array', items: { type: 'string' } },
    faxNumber: { type: 'array', items: { type: 'string' } },
    email: { type: 'array', items: { type: 'string' } },
    internet: { type: 'array', items: { type: 'string' } },
    SITA: { type: 'string' },
  },
  required: ['city', 'country'],
  additionalProperties: false,
} as const;

export const tools: ToolDefinition[] = [
  {
    name: 'build_data_module',
    description:
      'Build ONE S1000D data module (descript / proced / process / fault) or publication module (pm) from a structured draft and number it from the allocation rules. You give titles, paragraphs, steps, tables, figures and references as a tree; the server writes the XML (you never write XML, DMCs, ICNs or the BREX reference). The XML is verified (XSD, BREX along the brexDmRef chain, references; applicability too when a product is given); fixes the server is certain about (confidence "exact") are applied automatically and verified again, up to maxFixRounds times. Returns xml, fileName, dmCode (pmCode for a pm), verification, appliedFixes[] (what was changed automatically), fixes[] (what remains: candidates to choose from), the updated ledger and the next ICN number. Writes into the CSDB only when write is true. A malformed draft comes back as error.code "input-error" with the path of the problem; a draft without applic is one (path "/applic"): the server does not decide applicability, so give at least applic.displayText.',
    inputSchema: {
      type: 'object',
      properties: {
        draft: ref(
          'DraftDataModule',
          'The data module as a tree. kind decides which node kinds are accepted.',
        ),
        allocation: ref(
          'Allocation',
          'Numbering rules and the ledger. Pass the ledger of the previous response back so that the same sourceId keeps the same DMC and the same asset keeps the same ICN.',
        ),
        csdbDirs: csdbDirsParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        maxFixRounds: maxFixRoundsParam,
        maxFixes: maxFixesParam,
        product: productParam,
        issuePolicy: issuePolicyParam,
        assetFormats: assetFormatsParam,
      },
      required: ['draft', 'allocation'],
      additionalProperties: false,
      $defs: DEFS,
    },
  },
  {
    name: 'convert_manual',
    description:
      'Convert an experiential operation manual (@shuji-bonji/experiential-manual-model JSON) into S1000D: one publication module, one data module per topic (description → descript, procedure → proced, troubleshooting → fault, screenFlow → process plus one proced per screen), a glossary data module, applicability from the scopes, and ICNs for the assets. Every data module goes through the same flow as build_data_module (build, verify, automatic exact fixes, verify again); references between the data modules are resolved against the CSDB plus the data modules built in this call. A topic whose prerequisites list an item without an identifier (natoStockNumber or manufacturerCode) or without quantity is not built (its dataModules[] row carries error.code "input-error" and the path of the item; leaving the item out would write noSupplies, which reads as "nothing is required"); the other data modules are still built. Returns dataModules[], publicationModule, assets[] (assetId → ICN and the original file; with write: true the originals are copied under the ICN file name), the ledger, a summary of verification states and notRepresented (what the draft format cannot express). Nothing is written unless write is true.',
    inputSchema: {
      type: 'object',
      properties: {
        manual: {
          type: 'object',
          description:
            'The manual as JSON (Manual of experiential-manual-model). Alternative to manualPath.',
        },
        manualPath: {
          type: 'string',
          description:
            'Path of a manual JSON file. Relative asset paths are resolved from its folder.',
        },
        allocation: ref(
          'Allocation',
          'Numbering rules and the ledger. infoCodeByKind must give the info codes for descript, proced, process and fault (there is no default).',
        ),
        securityClassification: {
          type: 'string',
          description:
            'securityClassification for every data module (the manual has none; the value is written as given, not interpreted).',
        },
        language: {
          description:
            'Language of the output. Default: Manual.language ("ja" → ja-JP). A BCP 47 tag or { languageIsoCode, countryIsoCode }.',
          anyOf: [{ type: 'string' }, ref('Language')],
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Topic ids to convert (default: all; the glossary is converted only when all topics are).',
        },
        defaultApplic: ref(
          'DraftApplic',
          'applic for data modules without scopeRefs (default: display text "All" / "すべて").',
        ),
        responsiblePartnerCompany: { type: 'string' },
        originator: { type: 'string' },
        publicationModule: {
          type: 'boolean',
          description: 'Build the publication module too (default true).',
          default: true,
        },
        assetFormats: assetFormatsParam,
        assetBaseDir: {
          type: 'string',
          description:
            'Folder the relative Asset.source.path values are resolved from (default: the folder of manualPath).',
        },
        csdbDirs: csdbDirsParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        includeXml: {
          type: 'boolean',
          description:
            'Include the XML of every data module in the response (default: true when write is false, false when write is true).',
        },
        maxFixRounds: maxFixRoundsParam,
        maxFixes: maxFixesParam,
        product: productParam,
        issuePolicy: issuePolicyParam,
      },
      required: ['allocation', 'securityClassification'],
      additionalProperties: false,
      $defs: DEFS,
    },
  },
  {
    name: 'apply_fixes',
    description:
      'Apply fixes to an existing data module. Each selection copies the location and ONE candidate of a fix that s1000d-verify-mcp suggest_fixes (or this server) returned: { location, action, target?, value?, position? }. The server computes the fix candidates again and applies a selection only if it matches one of them; a value outside the candidates (or outside a range / pattern candidate) is not applied and comes back in rejected[] with the reason. "provide" candidates change the product, not the document: pass them as "product". The result is verified again. Returns xml, applied[], rejected[], verification, the fixes that remain. Writes only when write is true (a path is overwritten in place; xml is written under its own file name in the first CSDB folder).',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathParam,
        xml: xmlParam,
        csdbDirs: csdbDirsParam,
        selections: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              location: {
                type: 'object',
                description:
                  'Fix.location of the suggestion (omit when the fix has none, e.g. a missing element).',
                properties: {
                  path: { type: 'string' },
                  line: { type: 'integer' },
                  column: { type: 'integer' },
                },
                required: ['path'],
                additionalProperties: false,
              },
              action: { type: 'string', enum: ['replace', 'remove', 'add', 'retarget', 'provide'] },
              target: { type: 'string' },
              value: { type: 'string' },
              position: {
                type: 'string',
                enum: ['before'],
                description:
                  'Copy it when the candidate has "position" (an element added before the one at the location). Without it the selection does not match that candidate.',
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
        },
        product: productParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        maxFixes: maxFixesParam,
      },
      required: ['selections'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_data_module',
    description:
      'Change the structure of an EXISTING procedural or descriptive data module: insert a node, remove a node, move a node. Places are location.path values of the document as it is now (s1000d-reader-mcp read_data_module returns them); with several edits, every place still refers to the document before any edit. A node to insert is a structured draft node (step / para / admonition / listItem), never XML. All edits are applied or none: refusals[] gives the reason per edit (for example id-referenced, not-allowed-here, unsupported-node, released-issue). Only the edited ranges of the original text are rewritten; the rest stays character for character, and a moved element keeps its content unchanged. Elements that can be removed or moved: proceduralStep, para, warning, caution, note, listItem. Without "marking" this tool does NOT change the issue information or add change markup (changeType, changeMark, reasonForUpdate): a released issue (inWork "00") is refused unless allowReleasedIssue is true. With "marking" it adds change markup on an IN-WORK issue (start one with start_revision): an inserted node gets changeType="add"; a removed node is KEPT and gets changeType="delete" (changes[].kept); a move is accepted only within the same parent, which gets changeType="modify"; edits inside an element already marked add or delete get no markup; reasonForUpdate tells which reason the markup refers to. The result is verified again; XSD errors that the edits introduced come back in newSchemaErrors[] and such a result is never written. Returns applied, xml (unless includeXml is false), changes[] (each with mark when change markup was added), reasonForUpdate (with marking), refusals[], newSchemaErrors[], referencedFromOtherObjects[], verification, fixes[] (without candidates for the new XSD errors: change the edits and call again instead). Writes only when write is true (a path is overwritten in place).',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathParam,
        xml: xmlParam,
        csdbDirs: csdbDirsParam,
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['insert', 'remove', 'move'] },
              at: {
                type: 'string',
                description: 'remove / move: location.path of the node to remove or move.',
              },
              to: {
                type: 'string',
                description:
                  'insert / move: location.path of the reference node (the node beside or inside which the node goes).',
              },
              position: {
                type: 'string',
                enum: ['before', 'after', 'first-child', 'last-child'],
                description:
                  'insert / move: before / after the reference node, or as the first / last child of it. The XSD fixes the order of children (in a proceduralStep: warnings and cautions, then paragraphs, then nested steps); a wrong order comes back in newSchemaErrors[].',
              },
              node: {
                ...ref('DraftNode'),
                description:
                  'insert: the node to add (kind: step, para, admonition or listItem). An id that already exists in the document is refused; no id is made up.',
              },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
        marking: {
          type: 'object',
          description:
            'Add change markup for these edits (in-work issue only; issueType must be changed, status, rinstate-changed or rinstate-status). Give exactly ONE of reason and reasonRefId: "reason" adds a new reasonForUpdate and the markup refers to it (first edit for that reason; urt01 is refused, an editorial change has no change markup); "reasonRefId" is the id of a reasonForUpdate ALREADY in the status element (later edits for the same reason; nothing is added). One call = one reason: call again for edits with another reason. Omit marking to edit without change markup.',
          properties: {
            reason: reasonParam,
            reasonRefId: {
              type: 'string',
              description:
                'id of a reasonForUpdate already in the document (identAndStatus.reasonForUpdates[].id from s1000d-reader-mcp, or reasonForUpdate.id of an earlier response).',
            },
            changeMark: {
              type: 'string',
              enum: ['0', '1'],
              description:
                '"1": show a change mark (change bar) for these changes; "0": do not. The project decides; ask the user.',
            },
          },
          required: ['changeMark'],
          additionalProperties: false,
        },
        allowReleasedIssue: {
          type: 'boolean',
          description:
            'Edit a released issue (issueInfo/@inWork "00") in place, without changing the issue information or adding change markup. Default false. Set it only when the user has said so: the result does not follow the S1000D rules for updating a released data module. It has no effect with marking (a released issue is then always refused).',
        },
        product: productParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: {
          type: 'boolean',
          description:
            'Write even though the document was ALREADY invalid against the XSD before the edits. It does not allow writing a result with new XSD errors.',
        },
        includeXml: {
          type: 'boolean',
          description:
            'Include the XML in the response (default: true when write is false, false when write is true). Pass false to keep the response small when you only need changes[], refusals[], newSchemaErrors[] and verification.',
        },
        maxFixes: maxFixesParam,
      },
      required: ['edits'],
      additionalProperties: false,
      $defs: DEFS,
    },
  },
  {
    name: 'start_revision',
    description:
      'Start an in-work issue of a RELEASED data module (issueInfo/@inWork "00") so that it can be changed by the S1000D rules. The result is a NEW document: issueNumber unchanged, inWork "01", issueType as given; the released issue is never changed. The change markup of the previous issue is removed (changeType / changeMark / reasonForUpdateRefIds, changeInline tags with their text kept, every reasonForUpdate) and elements marked changeType="delete" are removed; only those ranges of the original text are rewritten. issueType is REQUIRED and is the user\'s decision: "changed" (changes shown with change markup: then edit with edit_data_module marking), "revised" (reworked, no change markup), "status" (only the identification and status section), "new" only when starting from issue 001-00. Optional "reason" adds one reasonForUpdate to the in-work issue in the same call (with revised or status from issue 002 on, the default BREX requires one). Refused: a document already in work, a deleted issue, an id of a removed element that the rest still refers to. Not done: release (inWork back to "00", issueNumber + 1), issueDate, quality assurance. Returns started, xml (unless includeXml is false), previous, issueInfo, issueType, fileName, removed{}, reasonForUpdate, refusals[], newSchemaErrors[], referencedFromOtherObjects[], verification, fixes[]. With write: true the in-work issue is written under fileName beside "path" (or into the CSDB when xml was given); an existing file of that name is a write-conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathParam,
        xml: xmlParam,
        csdbDirs: csdbDirsParam,
        issueType: {
          type: 'string',
          enum: ['changed', 'revised', 'status', 'new'],
          description:
            'issueType of the in-work issue. Ask the user; it is never chosen for you. "new" is accepted only when starting from 001-00 (it follows Chap 3.9.5.1 Table 3 but the default BREX reports BREX-S1-00030).',
        },
        reason: {
          ...reasonParam,
          description:
            'Optional: one reason for update to add to the in-work issue (same as add_reason_for_update). If it cannot be added, the in-work issue is not started either.',
        },
        product: productParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        includeXml: {
          type: 'boolean',
          description:
            'Include the XML in the response (default: true when write is false, false when write is true).',
        },
        maxFixes: maxFixesParam,
      },
      required: ['issueType'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_reason_for_update',
    description:
      'Add ONE reason for update (reasonForUpdate) to the status element of an IN-WORK data module, and nothing else: the content is not touched and no change markup is added. Use it for a change that has no change markup: an editorial change (updateReasonType urt01), or an issue whose issueType is revised or status. For a change that IS shown with change markup, do not use this tool: pass marking.reason to edit_data_module, which adds the reason and the markup together. A reason added here can be referred to by later marked edits through marking.reasonRefId (not a urt01 reason). The text and updateReasonType are the user\'s; nothing is filled in. Refused: a released issue (inWork "00": call start_revision first), an id already in the document. Returns added, xml (unless includeXml is false), reasonForUpdate {id, updateReasonType}, refusals[], newSchemaErrors[], verification, fixes[]. Writes only when write is true (a path is overwritten in place).',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathParam,
        xml: xmlParam,
        csdbDirs: csdbDirsParam,
        reason: reasonParam,
        product: productParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        includeXml: {
          type: 'boolean',
          description:
            'Include the XML in the response (default: true when write is false, false when write is true).',
        },
        maxFixes: maxFixesParam,
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_comment',
    description:
      'Build a comment data module (comment.xsd): a remark about data modules, publication modules, DMLs or DDNs, with the type (q / i / r), the priority code (cp01–cp99), paragraphs, the originator and the sender. The enumerations are written as given and not interpreted. The sequence number defaults to the next free one in the CSDB. The XML is verified (comment.xsd, BREX). Returns xml, fileName, commentCode, verification, fixes[]. Writes only when write is true.',
    inputSchema: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          items: commentRefSchema,
          description: 'What the comment is about (all of one kind). Empty: noReferences.',
        },
        commentType: { type: 'string', enum: ['q', 'i', 'r'] },
        commentPriorityCode: { type: 'string', pattern: '^cp(0[1-9]|[1-9][0-9])$' },
        title: { type: 'string' },
        paragraphs: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description: 'simplePara texts, written as given.',
        },
        originator: {
          type: 'object',
          properties: {
            enterpriseName: { type: 'string' },
            enterpriseCode: { type: 'string' },
            division: { type: 'string' },
            enterpriseUnit: { type: 'string' },
            person: {
              type: 'object',
              properties: {
                lastName: { type: 'string' },
                firstName: { type: 'string' },
                jobTitle: { type: 'string' },
                personPrefix: { type: 'string' },
              },
              required: ['lastName'],
              additionalProperties: false,
            },
            address: addressSchema,
          },
          required: ['enterpriseName', 'address'],
          additionalProperties: false,
        },
        senderIdent: { type: 'string', description: 'Sender enterprise code (5 characters).' },
        modelIdentCode: { type: 'string' },
        securityClassification: { type: 'string', description: '01–99, written as given.' },
        language: ref('Language'),
        yearOfDataIssue: { type: ['string', 'integer'], description: 'Default: this year.' },
        seqNumber: {
          type: ['string', 'integer'],
          description: 'Default: the next free number in the CSDB.',
        },
        responseType: { type: 'string', description: 'rt01–rt99. Omit for no commentResponse.' },
        issueDate: { type: 'string', description: 'YYYY-MM-DD (default today).' },
        brexDmRef: ref(
          'DmCode',
          'BREX the comment follows (default: the default BREX in S1000D_SPEC_DIR).',
        ),
        issueType: { type: 'string' },
        remarks: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        csdbDirs: csdbDirsParam,
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        maxFixes: maxFixesParam,
      },
      required: [
        'commentType',
        'commentPriorityCode',
        'paragraphs',
        'originator',
        'senderIdent',
        'modelIdentCode',
        'securityClassification',
        'language',
      ],
      additionalProperties: false,
      $defs: DEFS,
    },
  },
  {
    name: 'extract_segments',
    description:
      'Take the sentences that a person reads out of a data module so they can be translated: titles, paragraphs, step texts, warnings / cautions / notes, table cells and figure captions. Each segment has a stable id, its XPath, a context hint and the text, with inline elements (emphasis, references …) replaced by {1}, {2} placeholders that must stay in the translation. Attribute values, DMCs, ICNs, applicability expressions and ids are never offered. Also returns the skeletonHash to pass to apply_segments. The server does not translate and does not score translations.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathParam,
        xml: xmlParam,
        include: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['title', 'para', 'step', 'admonition', 'table', 'caption'],
          },
          description: 'Which kinds of sentences to return (default: all).',
        },
        maxSegments: {
          type: 'integer',
          minimum: 0,
          description: 'Cap on the number of segments returned.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'apply_segments',
    description:
      'Put translated sentences back into the data module they were taken from. The output has the same DMC with only the language changed (issueInfo too if given). It stops with error.code "skeleton-mismatch" when the data module changed since extract_segments (skeletonHash). A segment whose id is unknown, duplicated, or whose {n} placeholders do not match is not applied and is listed in unapplied[] (the original sentence stays). The result is verified. Writes only when write is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathParam,
        xml: xmlParam,
        csdbDirs: csdbDirsParam,
        skeletonHash: {
          type: 'string',
          description: 'The skeletonHash returned by extract_segments.',
        },
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, text: { type: 'string' } },
            required: ['id', 'text'],
            additionalProperties: false,
          },
          description: 'The translated sentences, by segment id.',
        },
        language: ref('Language', 'Target language written to dmIdent/language.'),
        issueInfo: ref(
          'IssueInfo',
          'Issue of the translated data module (default: same as the source).',
        ),
        write: writeParam,
        overwrite: overwriteParam,
        allowInvalid: allowInvalidParam,
        maxFixes: maxFixesParam,
      },
      required: ['skeletonHash', 'segments', 'language'],
      additionalProperties: false,
      $defs: DEFS,
    },
  },
];
