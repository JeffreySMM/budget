// The ring chart for expenses by category: which categories get a colour, and the drawing.
import { totalsByCategory } from './logic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DONUT_COLOURS = 6; // more slices than this cannot be told apart; the rest share grey "Other"
const DONUT_RADIUS = 40; // in a 100 × 100 viewBox
const DONUT_WIDTH = 16;
const DONUT_GAP = 1.2; // about 2px of page colour between slices

// Colours follow the category, not this month's ranking: the account's biggest
// categories of all time hold slots 1–6, so Groceries keeps its colour every month.
export const categorySlots = expenses =>
  new Map(totalsByCategory(expenses).slice(0, DONUT_COLOURS).map(({ category }, index) => [category, index + 1]));

// A ring of slices drawn as dashed circle strokes; colours come from classes (s1…s6, other).
export function donutSvg(slices, total) {
  const circumference = 2 * Math.PI * DONUT_RADIUS;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'donut');
  svg.setAttribute('aria-hidden', 'true'); // the list under it carries every number
  let start = 0;
  slices.forEach(({ cents, colour }) => {
    const length = (cents / total) * circumference;
    const gap = slices.length > 1 ? Math.min(DONUT_GAP, length / 2) : 0;
    const circle = document.createElementNS(SVG_NS, 'circle');
    const attributes = {
      cx: 50, cy: 50, r: DONUT_RADIUS, class: `slice ${colour}`, 'stroke-width': DONUT_WIDTH,
      'stroke-dasharray': `${length - gap} ${circumference - length + gap}`,
      'stroke-dashoffset': -start, transform: 'rotate(-90 50 50)',
    };
    Object.entries(attributes).forEach(([name, value]) => circle.setAttribute(name, value));
    svg.append(circle);
    start += length;
  });
  return svg;
}
