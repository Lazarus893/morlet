// One schema supplies the design prompt, host validation and React renderer.
import { z } from 'zod';
import { createLibrary, defineComponent, defineAction, action } from '@openuidev/lang-core';
import { reactive } from '@openuidev/react-lang';

export function createSurfaceLibrary(renderers = {}) {
  const component = (name, props, description) => defineComponent({ name, props: z.object(props), description, component: renderers[name] || (() => null) });
  const Text = component('Text', { text: z.string() }, 'Short explanation, not invented task facts.');
  const Metric = component('Metric', { label: z.string(), value: z.union([z.string(), z.number(), z.null()]), unit: z.string().optional() }, 'A fact from current_item or explicitly labelled local trial calculation. Null means unknown.');
  const NumberInput = component('NumberInput', { name: z.enum(['servings', 'budgetTotal']), label: z.string(), value: reactive(z.number()) }, 'Local trial value. Bind to $servings or $budgetTotal. Does not change the ledger.');
  const Button = component('Button', { label: z.string(), action: action() }, 'PreviewPlan only previews; adopting an adjustment requires the existing confirmed preview.');
  const Table = component('Table', { caption: z.string(), columns: z.array(z.object({ key: z.string(), label: z.string() })).max(6), rows: z.array(z.record(z.string(), z.unknown())) }, 'Read-only rows from current_item. Do not recreate ledger lists in literals.');
  const leaves = [Text, Metric, NumberInput, Button, Table];
  const Row = component('Row', { children: z.array(z.union(leaves.map(c => c.ref))).max(8) }, 'Responsive group; stacks on narrow screens.');
  const Section = component('Section', { title: z.string(), children: z.array(z.union([...leaves, Row].map(c => c.ref))).max(12) }, 'A short task-specific section.');
  const Panel = component('Panel', { title: z.string(), children: z.array(z.union([...leaves, Row, Section].map(c => c.ref))).max(16) }, 'Task-specific read-only facts and local trial controls, above the existing editable ledger cards.');
  return createLibrary({ id: 'xiaoman-surface-v1', root: 'Panel', components: [...leaves, Row, Section, Panel], actions: [
    defineAction({ name: 'PreviewPlan', description: 'Preview the impact of servings/budgetTotal; no write, approval or external action.', params: z.object({ servings: z.number().optional(), budgetTotal: z.number().optional() }) }),
  ] });
}

export const surfaceLibrary = createSurfaceLibrary();
export const surfacePrompt = () => surfaceLibrary.prompt({ bindings: true, toolCalls: true, builtinFunctions: false, tools: [
  { name: 'current_item', description: 'Read this task only. No arguments. Returns the complete current ledger item including taskData. Never changes it.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
] });
