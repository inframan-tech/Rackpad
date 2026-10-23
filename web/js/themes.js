// Themes. Colours for the page live in styles.css; these are the bits JS
// needs: trail style, the browser chrome colour, and the accent colours sent
// to the Mac so the cursor beacon and click ripples match the phone.

export const THEMES = [
  {
    id: 'neon', name: 'Neon', chrome: '#05060f',
    accent: '#00e5ff', accent2: '#ff3df2',
    trail: { colors: ['#00e5ff', '#ff3df2'], life: 420, width: 7, glow: 18, style: 'neon' },
  },
  {
    id: 'ipod', name: 'Retro iPod', chrome: '#e9ebee',
    accent: '#2f6fde', accent2: '#8aa0b0',
    trail: { colors: ['#2f6fde', '#6f9cf0'], life: 360, width: 5, glow: 0, style: 'ink' },
  },
  {
    id: 'glass', name: 'Glass', chrome: '#1a1033',
    accent: '#ffffff', accent2: '#ffc2ee',
    trail: { colors: ['#ffffff', '#c9e6ff'], life: 520, width: 9, glow: 22, style: 'soft' },
  },
  {
    id: 'black', name: 'Pure Black', chrome: '#000000',
    accent: '#d9d9d9', accent2: '#8c8c8c',
    trail: { colors: ['#5a5a5a', '#3a3a3a'], life: 260, width: 4, glow: 0, style: 'ink' },
  },
  {
    id: 'haze', name: 'Haze 🌿', chrome: '#050d08',
    accent: '#6dff9c', accent2: '#c6ff6d',
    trail: { colors: ['#6dff9c', '#c6ff6d'], life: 1100, width: 14, glow: 26, style: 'smoke' },
  },
];

export const themeById = (id) => THEMES.find((t) => t.id === id) ?? THEMES[0];
