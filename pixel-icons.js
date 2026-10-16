// 10 × 10 pixel-art icons for the retro look. '#' is black ink, '*' the icon's colour,
// '.' empty. Drawn as SVG squares, so they stay crisp at any size.
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  cart: ['#.........', '#.........', '.########.', '.#*#*#*#..', '.#######..', '..######..', '..........', '..#....#..', '.###..###.', '..#....#..'],
  coffee: ['..*.*.*...', '...*.*....', '..........', '.#######..', '.#*****###', '.#*****#.#', '.#*****###', '..#***#...', '...###....', '.#######..'],
  home: ['....##....', '...####...', '..######..', '.########.', '##########', '.#......#.', '.#.**...#.', '.#.**.###.', '.#.**.#*#.', '.########.'],
  bus: ['..######..', '.#******#.', '.#*#**#*#.', '.#******#.', '.########.', '.#.####.#.', '.########.', '.##....##.', '..........', '..##..##..'],
  bolt: ['.....**...', '....**....', '...**.....', '..******..', '.....**...', '....**....', '...**.....', '..**......', '.**.......', '..........'],
  phone: ['..#####...', '..#***#...', '..#***#...', '..#***#...', '..#***#...', '..#***#...', '..#####...', '..##.##...', '..#####...', '..........'],
  food: ['.#.#...#..', '.#.#..##..', '.###..##..', '..#...##..', '..#...##..', '..#....#..', '..#....#..', '..#....#..', '..#....#..', '..........'],
  heart: ['.##...##..', '#**#.#**#.', '#***#***#.', '#*******#.', '.#*****#..', '..#***#...', '...#*#....', '....#.....', '..........', '..........'],
  gift: ['...#..#...', '....##....', '##########', '#***##***#', '##########', '.#**##**#.', '.#**##**#.', '.#**##**#.', '.########.', '..........'],
  coin: ['...####...', '..#****#..', '.#**##**#.', '.#*#****#.', '.#**##**#.', '.#****#*#.', '.#**##**#.', '..#****#..', '...####...', '..........'],
  bag: ['...####...', '..#....#..', '..#....#..', '.########.', '.#******#.', '.#******#.', '.#******#.', '.#******#.', '.########.', '..........'],
  arrows: ['......#...', '......##..', '#########.', '......##..', '......#...', '...#......', '..##......', '.#########', '..##......', '...#......'],
  box: ['.########.', '#********#', '##########', '#********#', '#***##***#', '#********#', '#********#', '#********#', '##########', '..........'],
  star: ['....#.....', '....#.....', '...#*#....', '####*####.', '.#*****#..', '..#***#...', '..#*#*#...', '.#*#.#*#..', '.##...##..', '..........'],
};

const COLOURS = {
  cart: '#c00000', coffee: '#804000', home: '#c00000', bus: '#ffd800', bolt: '#ffd800', phone: '#00a0a0',
  food: '#000', heart: '#e00000', gift: '#e00000', coin: '#ffd800', bag: '#0080c0', arrows: '#000',
  box: '#c08040', star: '#ffd800',
};

// Category names (any letter case) to icons; others keep their letter badge.
const NAMES = {
  cart: ['groceries', 'supermarket'],
  coffee: ['coffee', 'drinks'],
  home: ['housing', 'rent'],
  bus: ['transport', 'taxi', 'car', 'travel', 'fuel', 'gas', 'parking'],
  bolt: ['utilities', 'electricity'],
  phone: ['phone', 'internet'],
  food: ['food', 'restaurants', 'restaurant', 'eating out', 'snacks'],
  heart: ['health', 'medical', 'pharmacy', 'gym', 'sports'],
  gift: ['gift', 'gifts', 'bonus'],
  coin: ['salary', 'interest', 'refund'],
  bag: ['shopping', 'clothes'],
  arrows: ['transfer'],
  box: ['other', 'subscriptions'],
  star: ['fun', 'entertainment', 'hobbies'],
};
const ICON_FOR_NAME = new Map(Object.entries(NAMES).flatMap(([icon, names]) => names.map(name => [name, icon])));

/** @returns {SVGSVGElement | null} the pixel icon for a common category name */
export function pixelIcon(name) {
  const key = ICON_FOR_NAME.get(name.trim().toLowerCase());
  if (!key) return null;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('shape-rendering', 'crispEdges');
  ICONS[key].forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell === '.') return;
    const pixel = document.createElementNS(SVG_NS, 'rect');
    Object.entries({ x, y, width: 1, height: 1, fill: cell === '#' ? '#000' : COLOURS[key] })
      .forEach(([attribute, value]) => pixel.setAttribute(attribute, value));
    svg.append(pixel);
  }));
  return svg;
}
