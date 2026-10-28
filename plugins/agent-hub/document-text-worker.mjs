import { parentPort, workerData } from 'node:worker_threads';

const LIMIT = 20000, PAGE_LIMIT = 100;
const bounded = text => { const chars = Array.from(text); return { text: chars.slice(0, LIMIT).join(''), textCharacters: Math.min(chars.length, LIMIT), truncated: chars.length > LIMIT }; };
try {
  const { bytes, format } = workerData;
  let value;
  if (format === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    let pdf;
    try {
      pdf = await loading.promise;
      const pages = [], emptyPages = []; let text = '';
      for (let n = 1; n <= Math.min(pdf.numPages, PAGE_LIMIT); n++) {
        const page = await pdf.getPage(n), content = await page.getTextContent();
        const body = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
        if (!body) emptyPages.push(n);
        text += (text ? '\n\n' : '') + `[第 ${n} 页]\n` + body; pages.push(n); page.cleanup();
        if (Array.from(text).length > LIMIT) break;
      }
      if (emptyPages.length === pages.length) throw Object.assign(new Error(), { code: 'SOURCE_DOCUMENT_OCR_REQUIRED' });
      const output = bounded(text), truncated = output.truncated || pages.length < pdf.numPages;
      value = { ...output, format, coverage: 'embedded_text_only', pagesRead: pages, totalPages: pdf.numPages, emptyPages, complete: !truncated && !emptyPages.length, truncated,
        limitations: ['图片、图表与手写内容未识别；排版和表格顺序需核对。', ...(emptyPages.length ? ['部分页没有可提取文字，需要 OCR。'] : [])] };
    } finally { await loading.destroy(); }
  } else {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    if (!result.value.trim()) throw Object.assign(new Error(), { code: 'SOURCE_DOCUMENT_TEXT_UNAVAILABLE' });
    const output = bounded(result.value), warnings = result.messages.length;
    value = { ...output, format, coverage: 'document_text_only', complete: !output.truncated && !warnings, warnings,
      limitations: ['仅提取文档文字，不识别图片、图表或原始分页。', ...(warnings ? ['解析器报告未识别内容，请核对原文。'] : [])] };
  }
  parentPort.postMessage({ value });
} catch (error) {
  const known = ['SOURCE_DOCUMENT_OCR_REQUIRED', 'SOURCE_DOCUMENT_TEXT_UNAVAILABLE'];
  parentPort.postMessage({ error: known.includes(error.code) ? error.code : error.name === 'PasswordException' ? 'SOURCE_DOCUMENT_PASSWORD_REQUIRED' : 'SOURCE_DOCUMENT_INVALID' });
}
