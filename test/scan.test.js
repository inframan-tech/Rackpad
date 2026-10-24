import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { tokenFromLink } from '../web/js/scan.js';

const jsQR = createRequire(import.meta.url)('jsqr');

test('the pairing code comes out of a scanned Rackpad link', () => {
  assert.equal(tokenFromLink('http://Prakhars-MacBook-Air.local:8421/?k=abc_DEF-123'), 'abc_DEF-123');
  assert.equal(tokenFromLink('https://192.168.1.7:8422/?k=xyz'), 'xyz');
  assert.equal(tokenFromLink('http://mac.local:8421/'), null);
  assert.equal(tokenFromLink('http://mac.local:8421/?k='), null);
  assert.equal(tokenFromLink('just some text'), null);
  assert.equal(tokenFromLink('javascript:alert(1)//?k=x'), null);
  assert.equal(tokenFromLink(null), null);
});

// The phone decodes with jsQR what the Mac draws with qrcode: make sure they agree.
test("the phone's decoder reads the Mac's pairing QR code", () => {
  const link = 'http://Prakhars-MacBook-Air-2.local:8421/?k=Qx3_vB9-kLm2Np5Rt8Wz0Yc4';
  const qr = QRCode.create(link, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const scale = 5;
  const quiet = 4;
  const size = (n + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      if (mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(mx, my)) rgba.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
  }
  const code = jsQR(rgba, size, size);
  assert.equal(code?.data, link);
  assert.equal(tokenFromLink(code.data), 'Qx3_vB9-kLm2Np5Rt8Wz0Yc4');
});
