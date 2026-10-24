// Live typing and dictation. Whatever is in the text field is mirrored onto
// the Mac keystroke by keystroke, including autocorrect and dictation going
// back to fix earlier words.

import { diffText, graphemes } from './textdiff.js';
import { onTap } from './touch.js';

// Keys that move the Mac's caret somewhere we can't follow: after one, the
// field starts fresh so new typing lands where the Mac's caret now is.
const NAV_KEYS = new Set(['return', 'tab', 'esc', 'left', 'right', 'up', 'down']);

export class Keys {
  constructor({ root, send, feel, live = true, onLiveChange = () => {} }) {
    this.root = root;
    this.send = send;
    this.feel = feel;
    this.field = root.querySelector('#type-field');
    this.liveBtn = root.querySelector('#live-toggle');
    this.sendBtn = root.querySelector('#type-send');
    this.clearBtn = root.querySelector('#type-clear');
    this.sent = '';
    this.composing = false;
    this.mods = new Set();
    this.onLiveChange = onLiveChange;
    this.setLive(live);

    const f = this.field;
    f.addEventListener('compositionstart', () => (this.composing = true));
    f.addEventListener('compositionend', () => {
      this.composing = false;
      this.sync();
    });
    f.addEventListener('input', () => {
      if (!this.composing) this.sync();
      this.tidy();
    });
    f.addEventListener('keydown', (e) => this.onKeyDown(e));

    onTap(this.liveBtn, () => {
      this.setLive(!this.live);
      this.onLiveChange(this.live);
    });
    onTap(this.clearBtn, () => this.reset());
    onTap(this.sendBtn, () => this.submit());
    for (const b of root.querySelectorAll('[data-key]')) onTap(b, () => this.pressKey(b.dataset.key));
    for (const b of root.querySelectorAll('[data-mod]')) onTap(b, () => this.toggleMod(b));
  }

  setLive(on) {
    this.live = on;
    this.liveBtn.setAttribute('aria-pressed', String(on));
    this.sendBtn.hidden = on;
    this.field.placeholder = on ? 'Type or dictate' : 'Write it here, then send';
    this.reset();
  }

  focus() {
    this.field.focus();
  }

  reset() {
    this.field.value = '';
    this.sent = '';
    this.tidy();
  }

  // The clear button only shows when there's something to clear.
  tidy() {
    this.clearBtn.hidden = !this.field.value;
  }

  // Mirror whatever changed since we last looked.
  sync() {
    if (!this.live) return;
    const value = this.field.value;
    const d = diffText(this.sent, value);
    if (!d) return;
    // With a sticky modifier on, the next character typed is a shortcut (⌘ then C = copy).
    if (this.mods.size && d.left === 0 && d.back === 0 && graphemes(d.text).length === 1) {
      this.send({ t: 'key', k: d.text, mods: [...this.mods] });
      this.field.value = this.sent;
      this.clearMods();
      this.feel('tap');
      return;
    }
    this.send({ t: 'type', ...d });
    this.sent = value;
  }

  submit() {
    const text = this.field.value;
    if (text) this.send({ t: 'type', left: 0, back: 0, text });
    this.reset();
    this.feel('tap');
  }

  onKeyDown(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!this.live) return this.submit();
      this.sync();
      this.pressKey('return');
    } else if (e.key === 'Backspace' && this.field.value === '') {
      // Nothing left in the field to delete, so delete on the Mac directly.
      e.preventDefault();
      this.send({ t: 'key', k: 'backspace' });
    }
  }

  pressKey(k) {
    if (k === 'backspace' && this.live && this.field.value) {
      // Delete from the field too, so both stay in step.
      this.field.value = graphemes(this.field.value).slice(0, -1).join('');
      this.sync();
      this.tidy();
      this.feel('tick');
      return;
    }
    this.send({ t: 'key', k, mods: [...this.mods] });
    this.clearMods();
    if (NAV_KEYS.has(k)) this.reset();
    this.feel('tick');
  }

  toggleMod(btn) {
    const m = btn.dataset.mod;
    if (this.mods.has(m)) this.mods.delete(m);
    else this.mods.add(m);
    btn.setAttribute('aria-pressed', String(this.mods.has(m)));
    this.feel('tick');
  }

  clearMods() {
    this.mods.clear();
    for (const b of this.root.querySelectorAll('[data-mod]')) b.setAttribute('aria-pressed', 'false');
  }
}
