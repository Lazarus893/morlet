import { execFileSync } from 'node:child_process';

export function pdfFixture(text = 'Meeting decision: approve the pilot.') {
  const stream = text ? `BT /F1 12 Tf 30 100 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, n) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${n + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return Buffer.from(pdf);
}
export function docxFixture(text = '会议决策：确认试点范围。') {
  // These bounded test strings travel as one argument, not through a pipe:
  // concurrent suite runs have stalled waiting for the Python stdin EOF.
  return execFileSync('python3', ['-c', `import io,sys,zipfile
from xml.sax.saxutils import escape
b=io.BytesIO()
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+escape(sys.argv[1])+'</w:t></w:r></w:p></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())`, text], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
}
