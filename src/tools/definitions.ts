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
    'CSDB folders (in addition to S1000D_CSDB_DIR) used to resolve references, find BREX and number new objects. The FIRST folder is also where write: true writes.',
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
      'Build ONE S1000D data module (descript / proced / process / fault) or publication module (pm) from a structured draft and number it from the allocation rules. You give titles, paragraphs, steps, tables, figures and references as a tree; the server writes the XML (you never write XML, DMCs, ICNs or the BREX reference). The XML is verified (XSD, BREX along the brexDmRef chain, references; applicability too when a product is given); fixes the server is certain about (confidence "exact") are applied automatically and verified again, up to maxFixRounds times. Returns xml, fileName, dmCode (pmCode for a pm), verification, appliedFixes[] (what was changed automatically), fixes[] (what remains: candidates to choose from), the updated ledger and the next ICN number. Writes into the CSDB only when write is true. A malformed draft comes back as error.code "input-error" with the path of the problem.',
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
      'Convert an experiential operation manual (@shuji-bonji/experiential-manual-model JSON) into S1000D: one publication module, one data module per topic (description → descript, procedure → proced, troubleshooting → fault, screenFlow → process plus one proced per screen), a glossary data module, applicability from the scopes, and ICNs for the assets. Every data module goes through the same flow as build_data_module (build, verify, automatic exact fixes, verify again); references between the data modules are resolved against the CSDB plus the data modules built in this call. Returns dataModules[], publicationModule, assets[] (assetId → ICN and the original file; with write: true the originals are copied under the ICN file name), the ledger, a summary of verification states and notRepresented (what the draft format cannot express). Nothing is written unless write is true.',
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
      'Apply fixes to an existing data module. Each selection copies the location and ONE candidate of a fix that s1000d-verify-mcp suggest_fixes (or this server) returned: { location, action, target?, value? }. The server computes the fix candidates again and applies a selection only if it matches one of them; a value outside the candidates (or outside a range / pattern candidate) is not applied and comes back in rejected[] with the reason. "provide" candidates change the product, not the document: pass them as "product". The result is verified again. Returns xml, applied[], rejected[], verification, the fixes that remain. Writes only when write is true (a path is overwritten in place; xml is written under its own file name in the first CSDB folder).',
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
