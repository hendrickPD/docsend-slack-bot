// Classify a Slack thread reply to a parked conversion.
//
// Slack wraps links as <url|label> and emails as <mailto:a@b.c|a@b.c>, and
// HTML-escapes "&". A reply is one of:
//   { kind: 'link',  url }    a DocSend verification link (tracking redirects
//                             carry docsend.com URL-encoded in their path)
//   { kind: 'email', email }  an email address to use instead of the default
//   { kind: 'text',  text }   anything else, e.g. a passcode
function unescapeSlack(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractDocSendVerificationUrl(text) {
  const urls = text.match(/https?:\/\/[^\s<>|]+/g) || [];
  for (const raw of urls) {
    const cleaned = unescapeSlack(raw).replace(/[.,;:)]+$/, '');
    let decoded = cleaned;
    try { decoded = decodeURIComponent(decodeURIComponent(cleaned)); } catch (_) {}
    if (/docsend\.com/i.test(decoded)) return cleaned;
  }
  return null;
}

function extractEmail(text) {
  const mailto = text.match(/<mailto:([^|>]+)/i);
  if (mailto) return mailto[1].trim();
  const plain = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return plain ? plain[0] : null;
}

// The reply with Slack's link/mention markup and surrounding quotes removed,
// collapsed to one line.
function plainText(text) {
  return unescapeSlack(text)
    .replace(/<[^>|]*\|([^>]*)>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^[\s"'`“”‘’]+|[\s"'`“”‘’]+$/g, '')
    .replace(/\s+/g, ' ');
}

function classifyReply(text) {
  const url = extractDocSendVerificationUrl(text);
  if (url) return { kind: 'link', url };
  const email = extractEmail(text);
  if (email) return { kind: 'email', email };
  const t = plainText(text);
  return t ? { kind: 'text', text: t } : null;
}

module.exports = { classifyReply, extractDocSendVerificationUrl, extractEmail, plainText };
