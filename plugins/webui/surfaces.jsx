import React, { createContext, useContext, useEffect, useLayoutEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Renderer, useStateField, useTriggerAction } from '@openuidev/react-lang';
import { Card } from '@openuidev/react-ui/Card';
import { CardHeader } from '@openuidev/react-ui/CardHeader';
import { Button } from '@openuidev/react-ui/Button';
import { Input } from '@openuidev/react-ui/Input';
import { FormControl } from '@openuidev/react-ui/FormControl';
import { Label } from '@openuidev/react-ui/Label';
import { MarkDownRenderer } from '@openuidev/react-ui/MarkdownRenderer';
import remarkGfm from 'remark-gfm';
import { TextContent } from '@openuidev/react-ui/TextContent';
import { MetricIndicatorWithStrikethrough } from '@openuidev/react-ui/MetricIndicator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openuidev/react-ui/Table';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@openuidev/react-ui/Accordion';
import { Tabs, TabsList, TabsTrigger } from '@openuidev/react-ui/Tabs';
import { AnimatePresence, motion, MotionConfig, useIsPresent } from 'motion/react';
import { createSurfaceLibrary } from '../life-journal/surface-library.mjs';
import './surfaces.css';

const Context = createContext({ disabled: false });
const subscribeMotion = callback => { window.addEventListener('pa-motion-change', callback); return () => window.removeEventListener('pa-motion-change', callback); };
const currentMotion = () => window.PAMotion?.mode() || 'system';
function useMotionMode() { return useSyncExternalStore(subscribeMotion, currentMotion, () => 'off'); }
const ease = [.23, 1, .32, 1];
const MotionAccordionContent = motion.create(AccordionContent);
function ReadingDisclosure({ mode, children }) {
  const ref = useRef(null), [height, setHeight] = useState(0), present = useIsPresent();
  useLayoutEffect(() => {
    const body = ref.current?.firstElementChild; if (!body) return;
    const measure = () => setHeight(body.getBoundingClientRect().height);
    measure(); const observer = new ResizeObserver(measure); observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const minimal = mode !== 'system', long = height > Math.min(560, innerHeight * .65);
  return <MotionAccordionContent ref={ref} forceMount className="jui-reading-content" aria-hidden={!present} inert={!present}
    initial={{ height: 0, opacity: 0 }} animate={{ height, opacity: 1 }} exit={{ height: minimal || long ? height : 0, opacity: 0 }}
    transition={{ height: { duration: minimal || long ? 0 : .22, ease }, opacity: { duration: mode === 'off' ? 0 : minimal ? .08 : .18, ease } }}>{children}</MotionAccordionContent>;
}
const readable = value => value === null || value === undefined ? '待补充' : typeof value === 'object' ? '—' : String(value);
const children = ({ props, renderNode }) => props.children.map((node, index) => <React.Fragment key={node?.statementId || index}>{renderNode(node)}</React.Fragment>);
function Panel(args) {
  const ref = useRef(null), { onControlsChange } = useContext(Context);
  useEffect(() => {
    // Report the controls that actually rendered; a failed or conditional view
    // must never remove the host's only way to adjust a plan.
    const previewFields = new Set([...ref.current.querySelectorAll('[data-surface-preview]')].flatMap(button => button.dataset.surfacePreview.split(' ')));
    const fields = [...ref.current.querySelectorAll('[data-surface-field]')].map(input => input.name).filter(name => previewFields.has(name));
    onControlsChange(fields);
  });
  return <Card ref={ref} width="full" className="jui-panel"><CardHeader title={<span role="heading" aria-level={3}>{args.props.title}</span>} />{children(args)}</Card>;
}
const library = createSurfaceLibrary({
  Text: ({ props }) => <TextContent variant="clear">{props.text}</TextContent>,
  Metric: ({ props }) => <MetricIndicatorWithStrikethrough className="jui-metric" value={`${readable(props.value)}${props.value != null && props.unit ? ` ${props.unit}` : ''}`} subtext={props.label} />,
  NumberInput: ({ props }) => {
    const field = useStateField(props.name, props.value), id = useId(), { disabled } = useContext(Context);
    return <FormControl className="jui-field"><Label htmlFor={id} disabled={disabled}>{props.label}</Label><Input id={id} name={props.name} data-surface-field type="number" size="large" required min={props.name === 'servings' ? 1 : 0} max={props.name === 'servings' ? 100 : 100000000} step={props.name === 'servings' ? 1 : '0.01'} value={field.value ?? ''} disabled={disabled} onChange={event => field.setValue(event.target.value === '' ? null : Number(event.target.value))} /></FormControl>;
  },
  Button: ({ props }) => {
    const trigger = useTriggerAction(), { disabled } = useContext(Context);
    const previewFields = props.action?.steps?.filter(step => step.type === 'custom_action' && step.name === 'PreviewPlan').flatMap(step => Object.keys(step.params || {}));
    return <Button type="button" variant="primary" size="large" className="jui-button" data-surface-preview={previewFields?.length ? previewFields.join(' ') : undefined} disabled={disabled} onClick={event => { if ([...event.currentTarget.closest('.jui-panel').querySelectorAll('input')].every(input => input.reportValidity())) trigger(props.label, undefined, props.action); }}>{props.label}</Button>;
  },
  Table: ({ props }) => <div className="jui-table-scroll" tabIndex={0} role="region" aria-label={props.caption}><Table><caption>{props.caption}</caption><TableHeader><TableRow>{props.columns.map(column => <TableHead key={column.key} scope="col">{column.label}</TableHead>)}</TableRow></TableHeader><TableBody>{props.rows.slice(0, 100).map((row, index) => <TableRow key={row.id || index}>{props.columns.map(column => <TableCell key={column.key}>{readable(Object.hasOwn(row, column.key) ? row[column.key] : null)}</TableCell>)}</TableRow>)}</TableBody></Table>{props.rows.length > 100 ? <TextContent variant="clear">此处显示前 100 项，完整材料见下方记录。</TextContent> : null}</div>,
  Row: args => <div className="jui-row">{children(args)}</div>,
  Section: args => <section className="jui-section"><CardHeader title={<span role="heading" aria-level={4}>{args.props.title}</span>} />{children(args)}</section>,
  Panel,
});
const mounts = new Map();
class Boundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onControlsChange([]); }
  render() { return this.state.failed ? <p role="status">这个视图暂时无法显示，下方记录仍可使用。</p> : this.props.children; }
}

function render(element, options) {
  let entry = mounts.get(element);
  if (!entry) { entry = { root: createRoot(element), state: {} }; mounts.set(element, entry); }
  entry.options = options;
  const { program, item, scope, disabled } = options, signature = JSON.stringify([program, item.version, scope, !!disabled]);
  if (entry.signature === signature) return;
  const storageKey = `xiaoman.surface.v1:${scope}:${item.id}`;
  if (entry.program !== program || entry.storageKey !== storageKey) {
    entry.state = {};
    try { const saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); if (saved.program === program && saved.state && JSON.stringify(saved.state).length <= 16384) entry.state = saved.state; } catch { /* Private browsing can disable storage. */ }
  }
  entry.signature = signature; entry.program = program; entry.storageKey = storageKey;
  // Version remount invalidates the upstream Query cache; local trial state is
  // explicitly rehydrated. Ordinary polling keeps the same input DOM and focus.
  const key = JSON.stringify([program, item.version, scope]);
  const onAction = event => {
    if (entry.options.disabled || event.type !== 'PreviewPlan') return;
    const params = Object.fromEntries(Object.entries(event.params || {}).filter(([name, value]) => ['servings', 'budgetTotal'].includes(name) && Number.isFinite(value)));
    if (!Object.keys(params).length) return;
    entry.options.onPreview(params);
  };
  const onControlsChange = fields => { if (mounts.get(element) === entry) entry.options.onControlsChange?.([...new Set(fields)].sort()); };
  entry.root.render(<Boundary key={key} onControlsChange={onControlsChange}><Context.Provider value={{ disabled: !!disabled, onControlsChange }}><Renderer key={key} response={program} library={library} isStreaming={false}
    initialState={entry.state} publishObservability={false} toolProvider={{ current_item: async () => item }}
    queryLoader={<p role="status">正在读取记录…</p>} onAction={onAction}
    onStateUpdate={state => { if (mounts.get(element) !== entry) return; entry.state = state; try { if (JSON.stringify(state).length <= 16384) localStorage.setItem(storageKey, JSON.stringify({ program, state })); } catch { /* Keep this session usable. */ } }}
  /></Context.Provider></Boundary>);
}
function unmount(element) { const entry = mounts.get(element); if (entry) { mounts.delete(element); entry.root.unmount(); } }
const frames = new Map(), readings = new Map();
function frame(element) {
  if (frames.has(element)) return;
  const root = createRoot(element);
  frames.set(element, root);
  // React owns the frame; the journal owns these stable, empty slots. Do not
  // re-render the frame when a record changes: that would replace live drafts.
  flushSync(() => root.render(<Card width="full" className="jui-workcard">
    <header className="journal-work-header" />
    <div className="journal-page-tabs" />
    <div className="journal-output" role="tabpanel">
    <div className="journal-work-report" />
    <div className="journal-surface" />
    <div className="journal-work-adjustments" />
    <div className="journal-work-body" />
    <footer className="journal-work-footer" />
    </div>
  </Card>));
}
function unframe(element) { const root = frames.get(element); if (root) { frames.delete(element); root.unmount(); } }
function ReadingEntry({ entry, metadata }) {
  const [open, setOpen] = useState(false), mode = useMotionMode(), minimal = mode !== 'system';
  const paragraphs = String(entry.note || '').split(/\n\s*\n/), summary = paragraphs.shift(), details = paragraphs.join('\n\n');
  let url; try { const parsed = new URL(entry.url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch { /* No source link. */ }
  return <div data-reading-entry={entry.id}><Card width="full" className="jw-auto-entry">
    <div className="jui-reading-meta"><span>{metadata?.topic || '来源材料'}</span>{metadata?.exploration ? <span className="jui-exploration">探索</span> : null}</div>
    <MotionConfig reducedMotion={minimal ? 'always' : 'never'}>
    <Accordion type="single" collapsible value={open ? 'reading' : ''} onValueChange={value => setOpen(!!value)} className="jui-reading-details">
      <AccordionItem value="reading">
      <AccordionTrigger text={metadata?.hook || entry.title} />
      <AnimatePresence initial={false}>
      {open && <ReadingDisclosure key="reading" mode={mode}>
      <p className="jui-reading-summary">{summary || '打开来源查看这条材料。'}</p>
      {details ? <p>{details}</p> : null}
    <div className="jui-reading-footer">
      {url ? <a href={url} target="_blank" rel="noopener noreferrer" data-content-open={metadata?.id}>原文 <span aria-hidden="true">↗</span></a> : <span />}
      {metadata ? <div className="jui-reading-feedback" role="group" aria-label="这条内容是否有帮助">
        {[['useful', '有用'], ['less', '少推'], ['not_interested', '不感兴趣']].map(([reaction, label]) => <Button key={reaction} type="button" variant={metadata.feedback === reaction ? 'secondary' : 'tertiary'} size="small" data-j-action="content-feedback" data-content-id={metadata.id} data-reaction={metadata.feedback === reaction ? 'clear' : reaction} aria-pressed={metadata.feedback === reaction}>{label}</Button>)}
      </div> : null}
    </div>
      </ReadingDisclosure>}
      </AnimatePresence>
      </AccordionItem>
    </Accordion>
    </MotionConfig>
  </Card></div>;
}
function renderReading(element, entries, metadata) {
  let entry = readings.get(element);
  if (!entry) { entry = { root: createRoot(element) }; readings.set(element, entry); }
  const page = element.closest('.journal-workpage');
  const reading = page ? page.dataset.expanded === 'true' : element.contains(document.activeElement) || !!element.querySelector('.jui-reading-details [data-state="open"]');
  const signature = JSON.stringify([entries, metadata, reading]);
  if (entry.signature === signature) return;
  entry.signature = signature;
  const ordered = [...entries].reverse();
  if (reading && entry.order) {
    const positions = new Map(entry.order.map((id, index) => [id, index]));
    ordered.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  entry.order = ordered.map(value => value.id);
  flushSync(() => entry.root.render(ordered.map(value => <ReadingEntry key={value.id} entry={value} metadata={metadata.find(row => row.entryId === value.id)} />)));
}
function clearReadings(container) {
  for (const [element, entry] of readings) if (!container || container.contains(element)) { readings.delete(element); entry.root.unmount(); }
}
const chrome = new Map();
function renderChrome(element, component) {
  let root = chrome.get(element); if (!root) { root = createRoot(element); chrome.set(element, root); }
  flushSync(() => root.render(component));
}
function clearReports(container) {
  for (const [element, root] of chrome) if (container?.contains(element)) { root.unmount(); chrome.delete(element); }
}
function JournalTabs({ value, onChange }) {
  return <Tabs value={value} onValueChange={onChange} activationMode="manual" className="jui-journal-tabs"><TabsList aria-label="手账视图">
    {[['recent', '近期'], ['all', '全部'], ['kept', '留下来的']].map(([id, label]) => <TabsTrigger key={id} value={id} text={label} data-j-tab={id} aria-pressed={value === id} aria-controls="journal-board" id={`journal-tab-${id}`} />)}
  </TabsList></Tabs>;
}
function ChapterTabs({ value, itemId, onChange }) {
  return <Tabs value={value} onValueChange={onChange} activationMode="manual" className="jui-journal-tabs"><TabsList aria-label="篇内视图">
    {[['output', '产物'], ['conversation', '对话']].map(([id, label]) => <TabsTrigger key={id} value={id} text={label} id={`chapter-tab-${itemId}-${id}`} aria-controls={`chapter-${itemId}-${id}`} />)}
  </TabsList></Tabs>;
}
function JournalStatus({ message }) {
  const mode = useMotionMode(), minimal = mode !== 'system';
  return <AnimatePresence initial={false}>{message && <motion.span key="status" className="jui-journal-status"
    initial={{ opacity: 0, y: minimal ? 0 : 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: minimal ? 0 : 4 }}
    transition={{ duration: mode === 'off' ? 0 : minimal ? .08 : .18, ease }}>{message}</motion.span>}</AnimatePresence>;
}
window.PAJournalSurfaces = { render, unmount, frame, unframe, renderReading, clearReadings, clearReports,
  renderReport: (element, text) => renderChrome(element, <MarkDownRenderer textMarkdown={text} variant="clear" options={{ remarkPlugins: [remarkGfm], skipHtml: true, components: { a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }, disallowedElements: ['img'], urlTransform: value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } } }} />),
  renderTabs: (element, options) => renderChrome(element, <JournalTabs {...options} />),
  renderChapterTabs: (element, options) => renderChrome(element, <ChapterTabs {...options} />),
  renderStatus: (element, message) => renderChrome(element, <JournalStatus message={message} />),
  clear: container => {
  clearReadings(container);
  for (const [element, root] of chrome) if (!container || container.contains(element)) { root.unmount(); chrome.delete(element); }
  for (const element of mounts.keys()) if (!container || container.contains(element)) unmount(element);
  for (const element of frames.keys()) if (!container || container.contains(element)) unframe(element);
} };
window.dispatchEvent(new Event('xiaoman-surfaces-ready'));
