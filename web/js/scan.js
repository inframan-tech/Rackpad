// Scanning the Mac's QR code from inside the app. A live camera preview needs
// HTTPS, which plain local Wi-Fi doesn't have, so this takes a photo with the
// phone's own camera instead and reads the code from that.

let decoder = null;

// The QR decoder is big, so it only loads the first time you scan.
function loadDecoder() {
  decoder ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/jsQR.js';
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => {
      decoder = null;
      reject(new Error('The QR decoder did not load'));
    };
    document.head.appendChild(script);
  });
  return decoder;
}

// The pairing code in a scanned Rackpad link ("http://mac.local:8421/?k=…"), or null.
export function tokenFromLink(text) {
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.searchParams.get('k') || null;
  } catch {
    return null;
  }
}

async function loadImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall back to an <img> below.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The text of the QR code in a photo, or null. Phone photos are huge: the
// code reads fine (and far faster) from a smaller copy, and a bigger one is
// tried only if that fails.
export async function readPhoto(file) {
  const [jsQR, image] = await Promise.all([loadDecoder(), loadImage(file)]);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const size of [1000, 2000]) {
    const k = Math.min(1, size / Math.max(width, height));
    canvas.width = Math.round(width * k);
    canvas.height = Math.round(height * k);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(pixels.data, canvas.width, canvas.height);
    if (code) return code.data;
    if (k === 1) break;
  }
  return null;
}
