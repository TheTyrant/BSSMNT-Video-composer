// Header quick pickers (v2.2, D-50). The topbar keeps its original
// readouts ("SRC LIVE", "MODE Spectrum Bars"); clicking a value opens a
// small menu. They drive the same controls as 01 Audio (the radio buttons
// and #visualMode), which stay where they are.
//  - SRC: Live input / Track file. Switching opens 01 Audio. The red light
//    shows audio activity (on while signal is coming in, brighter on beats).
//  - MODE: every visualization mode, each with its own icon.
class HeaderPickers {
  constructor(app) {
    this.app = app;
  }

  // 16×16 line icons, drawn in currentColor.
  static ICONS = {
    spectrum: '<path d="M2 14V9M5 14V4M8 14V7M11 14V2M14 14V10"/>',
    particles: '<circle cx="4" cy="5" r="1.4"/><circle cx="11" cy="3.5" r="1"/><circle cx="8" cy="9" r="1.6"/><circle cx="3.5" cy="12" r="1"/><circle cx="12.5" cy="11.5" r="1.3"/>',
    rings: '<circle cx="8" cy="8" r="2"/><circle cx="8" cy="8" r="4.5"/><circle cx="8" cy="8" r="7"/>',
    waves: '<path d="M1 8c1.75-4 3.5-4 5.25 0s3.5 4 5.25 0S15 4 15 4"/>',
    mandala: '<path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13"/><circle cx="8" cy="8" r="2.5"/>',
    tunnel: '<rect x="1.5" y="1.5" width="13" height="13"/><rect x="4.5" y="4.5" width="7" height="7"/><rect x="7" y="7" width="2" height="2"/>',
    galaxy: '<path d="M8 8c0-1.5 2-1.5 2 0s-1.5 3-3.5 3S3 9 3 7s2.5-4.5 5.5-4.5S14 5 14 8.5 11 14 7.5 14"/>',
    polygons: '<path d="M2 13l4-9 4 9z"/><path d="M9 6h5v5H9z"/>',
    layers: '<path d="M8 2l6.5 3.5L8 9 1.5 5.5z"/><path d="M1.5 8.5L8 12l6.5-3.5"/><path d="M1.5 11.5L8 15l6.5-3.5"/>',
    clips: '<rect x="1.5" y="3" width="13" height="10"/><path d="M4 3v10M12 3v10M1.5 6h2.5M1.5 10h2.5M12 6h2.5M12 10h2.5"/><path d="M7 6.5l2.5 1.5L7 9.5z"/>',
  };

  static icon(mode) {
    const body = HeaderPickers.ICONS[mode] || '';
    return `<svg class="mode-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${body}</svg>`;
  }

  init() {
    const $ = (id) => document.getElementById(id);
    // The header readouts are optional: if they're not in the page, do nothing.
    if (!$('srcBtn') || !$('modeBtn') || !$('srcLight')) return;
    this.modeSelect = $('visualMode');
    this.light = $('srcLight');

    this.src = this.makePicker($('srcBtn'), $('srcMenu'),
      () => [['mic', 'Live input'], ['file', 'Track file']].map(([v, label]) => ({ value: v, label, html: label })),
      () => this.app.audioSourceMode,
      (v) => {
        if (v !== this.app.audioSourceMode) $(v === 'file' ? 'audioSourceFile' : 'audioSourceMic').click();
        if (this.app.sidebar) this.app.sidebar.open('audio');
      });

    this.mode = this.makePicker($('modeBtn'), $('modeMenu'),
      () => Array.from(this.modeSelect.options).map(o => ({
        value: o.value, label: o.textContent,
        html: `${HeaderPickers.icon(o.value)}<span>${o.textContent}</span>`,
      })),
      () => this.modeSelect.value,
      (v) => {
        if (v === this.modeSelect.value) return;
        this.modeSelect.value = v;
        this.modeSelect.dispatchEvent(new Event('change'));
      });

    document.addEventListener('pointerdown', (e) => {
      [this.src, this.mode].forEach(p => { if (!p.root.contains(e.target)) p.close(); });
    });
    this.tick();
  }

  // A button + listbox menu. Arrow keys move, Enter/Space pick, Esc closes.
  makePicker(btn, menu, items, current, pick) {
    const root = btn.parentElement;
    const p = {
      root,
      open: () => {
        menu.innerHTML = '';
        items().forEach(it => {
          const li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.dataset.value = it.value;
          li.tabIndex = -1;
          li.innerHTML = it.html;
          li.setAttribute('aria-selected', String(it.value === current()));
          li.addEventListener('click', () => { pick(it.value); p.close(); btn.focus(); });
          menu.appendChild(li);
        });
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        const sel = menu.querySelector('[aria-selected="true"]') || menu.firstChild;
        if (sel) sel.focus();
      },
      close: () => {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      },
    };
    btn.addEventListener('click', () => (menu.hidden ? p.open() : p.close()));
    menu.addEventListener('keydown', (e) => {
      const opts = Array.from(menu.children);
      const i = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (opts[i + 1] || opts[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (opts[i - 1] || opts[opts.length - 1]).focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (opts[i]) opts[i].click(); }
      else if (e.key === 'Escape') { e.preventDefault(); p.close(); btn.focus(); }
      else if (e.key === 'Tab') p.close();
    });
    return p;
  }

  // Activity light: on while audio with signal is rolling; a ring on beats.
  tick() {
    requestAnimationFrame(() => this.tick());
    const viz = this.app.visualizer;
    const active = this.app.timelineRolling() && !!(viz.audioData && viz.audioData.isActive);
    this.light.classList.toggle('on', active);
    this.light.classList.toggle('beat', active && viz.beatFlash > 0.4);
  }
}
