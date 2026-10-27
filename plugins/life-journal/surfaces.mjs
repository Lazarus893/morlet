import { createParser, tokenize, split, parseExpression, walkAST } from '@openuidev/lang-core';
import { surfaceLibrary } from './surface-library.mjs';

const parser = createParser(surfaceLibrary.toJSONSchema());
const allowedCalls = new Set([...Object.keys(surfaceLibrary.components), 'Query', 'Action', 'Set', 'Reset', 'PreviewPlan']);
const fail = () => { throw Object.assign(new Error('INVALID_SURFACE'), { code: 'INVALID_SURFACE' }); };

export function validateSurface(program) {
  if (typeof program !== 'string' || !program.trim() || Buffer.byteLength(program) > 8192) fail();
  try {
    const result = parser.parse(program);
    if (!result.root || result.root.typeName !== 'Panel' || result.meta.incomplete || result.meta.unresolved.length || result.meta.errors.length || result.mutationStatements.length || result.queryStatements.length > 1) fail();
    const statements = split(tokenize(program));
    if (statements.length > 40 || new Set(statements.map(s => s.id)).size !== statements.length) fail();
    let count = 0;
    for (const statement of statements) walkAST(parseExpression(statement.tokens), node => {
      if (++count > 400) fail();
      if (node.k === 'Comp' && !allowedCalls.has(node.name)) fail();
      if (node.k === 'Comp' && node.name === 'Button' && (node.args[1]?.k !== 'Comp' || !['PreviewPlan', 'Set', 'Reset'].includes(node.args[1].name))) fail();
      if (node.k === 'Comp' && node.name === 'Query' && (node.args[0]?.k !== 'Str' || node.args[0].v !== 'current_item' || node.args.length > 3 || node.args[1]?.k !== 'Obj' || node.args[1].entries.length)) fail();
      if (node.k === 'Member' && ['__proto__', 'prototype', 'constructor'].includes(node.field)) fail();
      // Custom actions must use the checked @step grammar, not legacy JSON actions.
      if (node.k === 'Obj' && node.entries.some(([key]) => key === 'type')) fail();
    });
    return program;
  } catch { fail(); }
}

export function validateSurfaces(surfaces, widgets) {
  if (surfaces === undefined) return [];
  if (!Array.isArray(surfaces) || surfaces.length > 6) fail();
  const seen = new Set();
  return surfaces.map(surface => {
    if (!surface || Object.keys(surface).some(key => !['itemId', 'program'].includes(key)) || typeof surface.itemId !== 'string' || !widgets.some(widget => widget.itemId === surface.itemId) || seen.has(surface.itemId)) fail();
    seen.add(surface.itemId);
    return { itemId: surface.itemId, program: validateSurface(surface.program) };
  });
}
