// One Motion engine for the imperative shell. React islands use motion/react.
import { animate } from 'motion/mini';

const media = matchMedia('(prefers-reduced-motion: reduce)');
const ease = [0.23, 1, 0.32, 1];
let preference = 'system';
let keyboard = false;
const running = new Map();
const reduced = () => preference !== 'system' || media.matches;
const mode = () => preference === 'off' || keyboard ? 'off' : reduced() ? 'reduced' : 'system';
function cancel(element, finish = false) {
  const job = running.get(element);
  if (!job) return;
  running.delete(element); job.animation.stop();
  if (finish) job.finish();
}
function transition(element, frames, duration = .2, finish = () => {}, delay = 0) {
  if (!element?.isConnected) return Promise.resolve();
  cancel(element);
  if (mode() === 'off' || document.hidden) { finish(); return Promise.resolve(); }
  const animation = animate(element, frames, { duration, ease, delay });
  const job = { animation, finish };
  running.set(element, job);
  return animation.then(() => {
    if (running.get(element) !== job) return;
    running.delete(element); finish();
  });
}
function stop() { for (const element of [...running.keys()]) cancel(element, true); }
function play(element, kind = 'enter', delay = 0) {
  if (!element?.isConnected) return;
  const presets = {
    enter: { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] },
    page: { opacity: [0, 1], transform: ['translateX(10px)', 'translateX(0)'] },
    success: { opacity: [.6, 1] },
    change: { backgroundColor: ['#e0ebdd', 'rgba(224,235,221,0)'] },
    notice: { boxShadow: ['0 0 0 3px #8faa87', '0 0 0 0 transparent'] },
  };
  return transition(element, reduced() ? { opacity: [.75, 1] } : presets[kind] || presets.enter, reduced() ? .08 : kind === 'notice' ? .3 : .2, () => { element.style.removeProperty('opacity'); element.style.removeProperty('transform'); element.style.removeProperty('box-shadow'); element.style.removeProperty('background-color'); }, Math.min(delay / 1000, .12));
}
function exit(element, finish) {
  return transition(element, reduced() ? { opacity: 0 } : { opacity: 0, transform: 'translateY(5px)' }, reduced() ? .06 : .14, () => { finish(); element.style.removeProperty('opacity'); element.style.removeProperty('transform'); });
}
function toggle(details) {
  if (!details?.isConnected) return;
  const opening = details.dataset.motionTarget ? details.dataset.motionTarget !== 'open' : !details.open;
  const start = details.getBoundingClientRect().height;
  cancel(details);
  details.style.height = ''; details.style.overflow = '';
  details.open = true;
  const expanded = details.getBoundingClientRect().height;
  details.open = false;
  const collapsed = details.getBoundingClientRect().height;
  details.open = true;
  details.dataset.motionTarget = opening ? 'open' : 'closed';
  const finish = () => { details.open = opening; details.style.height = ''; details.style.overflow = ''; details.style.opacity = ''; delete details.dataset.motionTarget; };
  // Compact forms interpolate height. Multi-screen reading reveals fade without
  // racing thousands of pixels past the reader. Both directions have an exit.
  if (reduced() || expanded - collapsed > Math.min(560, innerHeight * .65)) {
    if (opening) { finish(); return play(details.querySelector(':scope > :not(summary)') || details, 'success'); }
    return transition(details, { opacity: [1, .65] }, reduced() ? .06 : .14, finish);
  }
  details.style.overflow = 'clip';
  return transition(details, { height: [start, opening ? expanded : collapsed] }, .22, finish);
}
function set(value) {
  const next = ['system', 'reduced', 'off'].includes(value) ? value : 'system';
  if (preference === next && document.documentElement.dataset.motion === next) return;
  preference = next; document.documentElement.dataset.motion = next;
  if (reduced()) stop();
  window.dispatchEvent(new Event('pa-motion-change'));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
media.addEventListener('change', () => { stop(); window.dispatchEvent(new Event('pa-motion-change')); });
function inputMode(value) {
  if (keyboard === value) return;
  keyboard = value; document.documentElement.dataset.input = value ? 'keyboard' : 'pointer';
  if (value) stop(); window.dispatchEvent(new Event('pa-motion-change'));
}
document.addEventListener('keydown', () => inputMode(true), { capture: true });
document.addEventListener('pointerdown', () => inputMode(false), { capture: true });
window.PAMotion = { play, exit, toggle, stop, reduced, mode, set, cancel };
