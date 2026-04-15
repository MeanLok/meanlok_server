import { Injectable } from '@nestjs/common';
import DOMPurify from 'isomorphic-dompurify';

let sanitizeHooksInstalled = false;
const SAFE_URI_PATTERN = /^(?:https?:|mailto:|#|\/|meanlok-image:)/i;

function isSafeUri(value: string) {
  const normalized = value.trim().replace(/^['"]|['"]$/g, '');
  return SAFE_URI_PATTERN.test(normalized);
}

function normalizeSrcSet(value: string) {
  const safeEntries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [urlPart, descriptorPart] = entry.split(/\s+/, 2);
      if (!urlPart || !isSafeUri(urlPart)) {
        return null;
      }
      return descriptorPart ? `${urlPart} ${descriptorPart}` : urlPart;
    })
    .filter((entry): entry is string => Boolean(entry));

  return safeEntries.length ? safeEntries.join(', ') : null;
}

function ensureSanitizeHooks() {
  if (sanitizeHooksInstalled) {
    return;
  }

  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    const attribute = data.attrName?.toLowerCase() ?? '';
    if (attribute.startsWith('on') || attribute === 'style') {
      data.keepAttr = false;
      return;
    }

    if (attribute === 'href' || attribute === 'src') {
      if (!isSafeUri(data.attrValue ?? '')) {
        data.keepAttr = false;
      }
      return;
    }

    if (attribute === 'srcset') {
      const normalized = normalizeSrcSet(data.attrValue ?? '');
      if (!normalized) {
        data.keepAttr = false;
        return;
      }
      data.attrValue = normalized;
    }
  });

  sanitizeHooksInstalled = true;
}

const SANITIZE_OPTIONS: Exclude<
  Parameters<typeof DOMPurify.sanitize>[1],
  undefined
> = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'a',
    'code',
    'pre',
    'blockquote',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'img',
    'span',
    'div',
  ],
  ALLOWED_ATTR: [
    'href',
    'target',
    'rel',
    'src',
    'srcset',
    'sizes',
    'loading',
    'decoding',
    'fetchpriority',
    'alt',
    'title',
    'class',
    'colspan',
    'rowspan',
  ],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/|meanlok-image:)/i,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
};

@Injectable()
export class SanitizeService {
  constructor() {
    ensureSanitizeHooks();
  }

  sanitize(html: string): string {
    return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
  }
}
