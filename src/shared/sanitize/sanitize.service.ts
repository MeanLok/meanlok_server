import { Injectable } from '@nestjs/common';
import DOMPurify from 'isomorphic-dompurify';

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
    'alt',
    'title',
    'class',
    'colspan',
    'rowspan',
  ],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#|\/)/i,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
};

@Injectable()
export class SanitizeService {
  sanitize(html: string): string {
    return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
  }
}
