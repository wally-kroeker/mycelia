import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';

// ═══ Types ═══

export interface SanitizeResult {
  safe: boolean;
  reason?: string;
  cleaned?: string;
  score?: number;
  matches?: string[];
}

interface PatternRule {
  pattern: RegExp;
  score: number;
  category: string;
  description: string;
}

// ═══ Configuration ═══

/** Score threshold at or above which content is rejected */
const BLOCK_THRESHOLD = 10;

/** Score threshold at or above which content is flagged (but allowed) */
const WARN_THRESHOLD = 5;

// ═══ Code Block Handling ═══

/**
 * Strip code blocks from text before pattern matching.
 * This prevents false positives on legitimate code review content
 * where injection-like patterns appear inside code blocks.
 *
 * Handles:
 * - Fenced code blocks: ```...``` and ~~~...~~~
 * - Inline code: `...`
 */
function stripCodeBlocks(text: string): string {
  // Remove fenced code blocks (```...``` or ~~~...~~~)
  let stripped = text.replace(/```[\s\S]*?```/g, ' [CODE_BLOCK] ');
  stripped = stripped.replace(/~~~[\s\S]*?~~~/g, ' [CODE_BLOCK] ');
  // Remove inline code (`...`)
  stripped = stripped.replace(/`[^`]+`/g, ' [INLINE_CODE] ');
  return stripped;
}

// ═══ Pattern Library ═══

/**
 * Injection detection patterns, organized by attack category.
 * Each pattern has a risk score — scores are additive across matches.
 *
 * Design principles:
 * - Patterns match OUTSIDE code blocks (code blocks are stripped first)
 * - Case-insensitive matching for most patterns
 * - Word boundaries used where appropriate to reduce false positives
 * - Scores calibrated so a single weak signal doesn't trigger blocking
 */
const PATTERNS: PatternRule[] = [
  // ── System Prompt Override (score: 8) ──
  {
    pattern: /\[SYSTEM\]|\[INST\]|<<SYS>>|<\/?system>/i,
    score: 8,
    category: 'system_override',
    description: 'System prompt delimiter injection'
  },
  {
    pattern: /you\s+are\s+now\s+(operating|running|functioning|working)\s+(in|as|under)/i,
    score: 8,
    category: 'system_override',
    description: 'Operational mode override attempt'
  },
  {
    pattern: /\bnew\s+(system\s+)?instructions?\b.*:/i,
    score: 7,
    category: 'system_override',
    description: 'New instruction injection'
  },
  {
    pattern: /\byour\s+new\s+(task|role|purpose|objective|mission)\b/i,
    score: 7,
    category: 'system_override',
    description: 'Role reassignment attempt'
  },

  // ── Ignore-Previous Instructions (score: 7) ──
  {
    pattern: /\b(ignore|disregard|forget|override|bypass)\b.{0,30}\b(previous|prior|above|earlier|all|original|initial)\b.{0,30}\b(instructions?|prompts?|guidelines?|rules?|directives?|constraints?)\b/i,
    score: 7,
    category: 'ignore_previous',
    description: 'Ignore-previous-instructions pattern'
  },
  {
    pattern: /\b(ignore|disregard|forget)\b.{0,15}\b(everything|anything)\b.{0,15}\b(above|before|previously|said|told)\b/i,
    score: 7,
    category: 'ignore_previous',
    description: 'Broad ignore-everything pattern'
  },
  {
    pattern: /\bdo\s+not\s+follow\b.{0,30}\b(previous|prior|original|initial)\b/i,
    score: 7,
    category: 'ignore_previous',
    description: 'Do-not-follow pattern'
  },

  // ── Role-Play Manipulation (score: 5) ──
  {
    pattern: /\b(pretend|imagine|act\s+as\s+if|roleplay|role[\s-]play)\b.{0,40}\byou\s+(are|were|have)\b/i,
    score: 5,
    category: 'roleplay',
    description: 'Role-play identity manipulation'
  },
  {
    pattern: /\bfrom\s+now\s+on\b.{0,30}\byou\b.{0,20}\b(are|will|must|should)\b/i,
    score: 5,
    category: 'roleplay',
    description: 'Persistent identity change attempt'
  },
  {
    pattern: /\b(DAN|jailbreak|do\s+anything\s+now)\b/i,
    score: 6,
    category: 'roleplay',
    description: 'Known jailbreak pattern (DAN)'
  },

  // ── Base64 Payload Detection (score: 6) ──
  // Matches base64 strings of 40+ chars that aren't obviously file hashes or tokens
  {
    pattern: /(?<![a-zA-Z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![a-zA-Z0-9+/=])/,
    score: 6,
    category: 'encoded_payload',
    description: 'Suspicious base64-encoded payload'
  },

  // ── Authority Impersonation (score: 5) ──
  {
    pattern: /\b(PRIORITY|URGENT|CRITICAL)\s+(DIRECTIVE|UPDATE|NOTICE|INSTRUCTION|ORDER)\b/,
    score: 5,
    category: 'authority',
    description: 'Authority impersonation via urgent directive'
  },
  {
    pattern: /---\s*(IMPORTANT\s+)?(UPDATE|NOTICE|DIRECTIVE|MESSAGE)\s+(FROM|BY)\b/i,
    score: 5,
    category: 'authority',
    description: 'Fake official notice delimiter'
  },
  {
    pattern: /\b(network\s+admin|system\s+administrator|official\s+bot|mycelia\s+team)\b/i,
    score: 4,
    category: 'authority',
    description: 'Mycelia authority impersonation'
  },

  // ── Data Exfiltration Attempts (score: 6) ──
  {
    pattern: /\b(share|reveal|output|display|show|repeat|echo)\b.{0,30}\b(system\s+prompt|api\s+key|secret|credentials?|password|token|configuration)\b/i,
    score: 6,
    category: 'exfiltration',
    description: 'Data exfiltration request'
  },
  {
    pattern: /\b(include|embed|insert|append)\b.{0,20}\b(hidden|invisible|secret)\b/i,
    score: 5,
    category: 'exfiltration',
    description: 'Hidden content insertion attempt'
  },

  // ── HTML/Markdown Injection (score: 3-4) ──
  {
    pattern: /<script[\s>]/i,
    score: 4,
    category: 'html_injection',
    description: 'Script tag injection'
  },
  {
    pattern: /<img\s[^>]*src\s*=\s*["']https?:\/\//i,
    score: 3,
    category: 'html_injection',
    description: 'Remote image injection (tracking pixel)'
  },
  {
    pattern: /<(?:iframe|object|embed|form|input|meta|link)\b/i,
    score: 4,
    category: 'html_injection',
    description: 'Dangerous HTML element injection'
  },
  {
    pattern: /!\[(?:[^\]]*)\]\(https?:\/\/[^)]*\)/,
    score: 2,
    category: 'html_injection',
    description: 'Markdown image with external URL (potential tracking)'
  },
  {
    pattern: /style\s*=\s*["'][^"']*display\s*:\s*none/i,
    score: 4,
    category: 'html_injection',
    description: 'Hidden element via CSS'
  },

  // ── Unicode Homoglyph Detection (score: 4) ──
  // Detects Cyrillic characters commonly used to impersonate Latin text
  {
    pattern: /[\u0400-\u04FF]/,
    score: 4,
    category: 'homoglyph',
    description: 'Cyrillic characters detected (potential homoglyph attack)'
  },
  // Other confusable script blocks
  {
    pattern: /[\u2000-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/,
    score: 3,
    category: 'homoglyph',
    description: 'Invisible unicode characters detected'
  },

  // ── Prompt Leaking (score: 5) ──
  {
    pattern: /\bwhat\s+(is|are)\s+your\s+(system\s+)?instructions?\b/i,
    score: 5,
    category: 'prompt_leak',
    description: 'System prompt extraction attempt'
  },
  {
    pattern: /\b(print|output|display|show)\s+(your\s+)?(initial|original|full|complete)\s+(prompt|instructions?|system\s+message)\b/i,
    score: 6,
    category: 'prompt_leak',
    description: 'Direct prompt extraction'
  },
];

// ═══ Core Sanitization Function ═══

/**
 * Analyze text content for prompt injection patterns.
 *
 * How it works:
 * 1. Strip code blocks to avoid false positives on legitimate code content
 * 2. Run all patterns against the stripped text
 * 3. Sum scores from all matching patterns
 * 4. Return safe/unsafe verdict with details
 *
 * @param text - The text content to check
 * @param fieldName - Optional field name for better error messages
 * @returns SanitizeResult with safety verdict, score, and matched patterns
 */
export function sanitizeInput(text: string, fieldName?: string): SanitizeResult {
  if (!text || text.trim().length === 0) {
    return { safe: true, score: 0, matches: [] };
  }

  // Strip code blocks before pattern matching
  const strippedText = stripCodeBlocks(text);

  let totalScore = 0;
  const matchedCategories: string[] = [];
  const matchDetails: string[] = [];

  for (const rule of PATTERNS) {
    if (rule.pattern.test(strippedText)) {
      totalScore += rule.score;
      if (!matchedCategories.includes(rule.category)) {
        matchedCategories.push(rule.category);
      }
      matchDetails.push(`${rule.category}: ${rule.description} (+${rule.score})`);
    }
  }

  // Build result
  if (totalScore >= BLOCK_THRESHOLD) {
    const fieldRef = fieldName ? ` in '${fieldName}'` : '';
    return {
      safe: false,
      reason: `Content${fieldRef} blocked: potential prompt injection detected (score: ${totalScore}/${BLOCK_THRESHOLD}). Categories: ${matchedCategories.join(', ')}`,
      cleaned: cleanContent(text),
      score: totalScore,
      matches: matchDetails
    };
  }

  if (totalScore >= WARN_THRESHOLD) {
    return {
      safe: true,
      reason: `Content flagged for monitoring (score: ${totalScore}/${BLOCK_THRESHOLD}). Categories: ${matchedCategories.join(', ')}`,
      score: totalScore,
      matches: matchDetails
    };
  }

  return { safe: true, score: totalScore, matches: matchDetails };
}

// ═══ Content Cleaning ═══

/**
 * Attempt to produce a cleaned version of content by neutralizing
 * known injection patterns. Used as a fallback for borderline content.
 */
function cleanContent(text: string): string {
  let cleaned = text;

  // Neutralize system prompt delimiters
  cleaned = cleaned.replace(/\[SYSTEM\]/gi, '[BLOCKED:SYSTEM]');
  cleaned = cleaned.replace(/\[INST\]/gi, '[BLOCKED:INST]');
  cleaned = cleaned.replace(/<<SYS>>/gi, '<<BLOCKED:SYS>>');
  cleaned = cleaned.replace(/<\/?system>/gi, '<BLOCKED:system>');

  // Neutralize HTML injection
  cleaned = cleaned.replace(/<script/gi, '<BLOCKED:script');
  cleaned = cleaned.replace(/<iframe/gi, '<BLOCKED:iframe');
  cleaned = cleaned.replace(/<object/gi, '<BLOCKED:object');
  cleaned = cleaned.replace(/<embed/gi, '<BLOCKED:embed');
  cleaned = cleaned.replace(/<form/gi, '<BLOCKED:form');
  cleaned = cleaned.replace(/<img\s/gi, '<BLOCKED:img ');

  // Neutralize invisible unicode characters
  cleaned = cleaned.replace(/[\u200B-\u200F\u2028-\u202F\u205F-\u206F\uFEFF]/g, '');

  return cleaned;
}

// ═══ Hono Middleware ═══

/**
 * Field definitions for each route that needs sanitization.
 * Maps route patterns to the fields that should be checked.
 */
interface FieldConfig {
  /** JSON body field name */
  field: string;
  /** Human-readable field label for error messages */
  label: string;
  /** Maximum allowed length (for basic validation) */
  maxLength?: number;
}

const ROUTE_FIELD_MAP: Record<string, FieldConfig[]> = {
  // POST /v1/agents — registration (authenticated)
  'POST:/v1/agents': [
    { field: 'name', label: 'Agent name', maxLength: 50 },
    { field: 'description', label: 'Agent description', maxLength: 500 },
  ],
  // POST /v1/agents/register — public registration
  'POST:/v1/agents/register': [
    { field: 'name', label: 'Agent name', maxLength: 50 },
    { field: 'description', label: 'Agent description', maxLength: 500 },
  ],
  // PATCH /v1/agents/:id — update
  'PATCH:/v1/agents/': [
    { field: 'description', label: 'Agent description', maxLength: 500 },
  ],
  // POST /v1/requests — create help request
  'POST:/v1/requests': [
    { field: 'title', label: 'Request title', maxLength: 200 },
    { field: 'body', label: 'Request body', maxLength: 5000 },
    { field: 'context', label: 'Request context', maxLength: 5000 },
  ],
  // POST /v1/requests/:id/claims — claim a request
  'POST:/v1/requests/*/claims': [
    { field: 'note', label: 'Claim note', maxLength: 1000 },
  ],
  // POST /v1/requests/:id/responses — submit response
  'POST:/v1/requests/*/responses': [
    { field: 'body', label: 'Response body', maxLength: 10000 },
  ],
  // POST /v1/responses/:id/ratings — rate a response
  'POST:/v1/responses/*/ratings': [
    { field: 'feedback', label: 'Rating feedback', maxLength: 2000 },
  ],
  // POST /v1/capabilities/propose — propose new tag
  'POST:/v1/capabilities/propose': [
    { field: 'description', label: 'Tag description', maxLength: 500 },
  ],
};

/**
 * Match a request method+path against the route field map.
 * Supports wildcard segments (*) for path parameters.
 */
function findFieldConfig(method: string, path: string): FieldConfig[] | null {
  // Try exact match first
  const exact = ROUTE_FIELD_MAP[`${method}:${path}`];
  if (exact) return exact;

  // Try prefix match (for PATCH /v1/agents/:id)
  for (const [routeKey, fields] of Object.entries(ROUTE_FIELD_MAP)) {
    const [routeMethod, routePath] = routeKey.split(':');
    if (routeMethod !== method) continue;

    // Check if route pattern with wildcards matches
    if (routePath.includes('*')) {
      const regex = new RegExp('^' + routePath.replace(/\*/g, '[^/]+') + '$');
      if (regex.test(path)) return fields;
    }

    // Check prefix match (for PATCH routes)
    if (routePath.endsWith('/') && path.startsWith(routePath)) {
      return fields;
    }
  }

  return null;
}

/**
 * Hono middleware that sanitizes request body fields for injection patterns.
 *
 * Usage:
 *   import { contentSanitizer } from './middleware/sanitize';
 *   app.use('/v1/*', contentSanitizer);
 *
 * Or apply to specific routes:
 *   app.post('/v1/requests', contentSanitizer, createRequestHandler);
 *
 * Behavior:
 * - Only processes POST/PATCH/PUT requests with JSON bodies
 * - Checks fields defined in ROUTE_FIELD_MAP for the matching route
 * - Returns 422 with details if injection is detected (score >= BLOCK_THRESHOLD)
 * - Passes through if content is safe or route has no configured fields
 */
export const contentSanitizer = createMiddleware(async (c: Context, next: Next) => {
  const method = c.req.method;

  // Only check mutation methods
  if (!['POST', 'PATCH', 'PUT'].includes(method)) {
    await next();
    return;
  }

  // Find field configuration for this route
  const path = new URL(c.req.url).pathname;
  const fieldConfigs = findFieldConfig(method, path);

  if (!fieldConfigs) {
    await next();
    return;
  }

  // Parse body — clone the request so downstream can also read it
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    // Not JSON or no body — let downstream validation handle it
    await next();
    return;
  }

  // Check each configured field
  const violations: Array<{ field: string; reason: string }> = [];

  for (const config of fieldConfigs) {
    const value = body[config.field];
    if (typeof value !== 'string' || value.trim().length === 0) continue;

    const result = sanitizeInput(value, config.label);

    if (!result.safe) {
      violations.push({
        field: config.field,
        reason: result.reason || 'Potential prompt injection detected'
      });
    }
  }

  if (violations.length > 0) {
    return c.json({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Content rejected: potential prompt injection detected',
        details: violations
      },
      meta: {
        request_id: crypto.randomUUID(),
        timestamp: new Date().toISOString()
      }
    }, 422);
  }

  await next();
});
