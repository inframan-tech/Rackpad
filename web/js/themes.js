// The look: a glass surface (black or silver, like the Magic Trackpad) and a
// single accent colour. The accent is the only colour in the UI; it's sent to
// the Mac too, so the cursor glow and click ripples match the phone.

export const SURFACES = [
  { id: 'black', name: 'Black', chrome: '#000000', light: false },
  { id: 'silver', name: 'Silver', chrome: '#dcdce1', light: true },
];

export const ACCENTS = [
  { id: 'ice', name: 'Ice', color: '#64d2ff' },
  { id: 'blue', name: 'Blue', color: '#0a84ff' },
  { id: 'violet', name: 'Violet', color: '#bf5af2' },
  { id: 'pink', name: 'Pink', color: '#ff375f' },
  { id: 'orange', name: 'Orange', color: '#ff9f0a' },
  { id: 'green', name: 'Green', color: '#30d158' },
];

export const surfaceById = (id) => SURFACES.find((s) => s.id === id) ?? SURFACES[0];
export const accentById = (id) => ACCENTS.find((a) => a.id === id) ?? ACCENTS[0];
