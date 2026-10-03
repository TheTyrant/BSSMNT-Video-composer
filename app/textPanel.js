// 04 Text panel (v2.4, D-60): add and edit titles, credits and text.
class TextPanel {
  constructor(app) {
    this.app = app;
    this.text = app.text;
  }

  init() {
    const $ = (id) => document.getElementById(id);
    this.list = $('textList');
    this.props = $('textProps');
    if (!this.list) return;
    $('textAddTitle').addEventListener('click', () => this.text.add('title'));
    $('textAddCredits').addEventListener('click', () => this.text.add('credits'));
    $('textAddText').addEventListener('click', () => this.text.add('text'));
    this.text.on((type) => { if (type !== 'tick') this.render(); });
    // Preview the selected item on screen while this panel is open.
    if (this.app.sidebar) this.app.sidebar.on((open) => { this.text.previewing = open.includes('text'); });
    this.render();
  }

  label(it) {
    const first = String(it.content || '').split('\n').find(l => l.trim()) || '(empty)';
    return first.replace(/^#\s*/, '');
  }

  timeText(it) {
    const w = this.text.windowOf(it);
    if (!w) return it.anchor === 'end' ? 'End · live: Show now' : '—';
    return `${fmtTime(w[0], true)}–${fmtTime(w[1], true)}`;
  }

  render() {
    const sel = this.text.selectedId;
    this.list.textContent = '';
    this.text.items.forEach(it => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'asset-row text-row' + (it.id === sel ? ' selected' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(it.id === sel));
      const kind = document.createElement('span');
      kind.className = 'text-kind';
      kind.textContent = it.kind === 'title' ? 'T' : it.kind === 'credits' ? 'CR' : 'Aa';
      const name = document.createElement('span');
      name.className = 'asset-name';
      name.textContent = this.label(it);
      const tags = document.createElement('span');
      tags.className = 'asset-tags';
      tags.textContent = this.timeText(it);
      row.append(kind, name, tags);
      row.addEventListener('click', () => this.text.select(it.id));
      this.list.appendChild(row);
    });
    this.renderProps(this.text.get(sel));
  }

  renderProps(it) {
    const P = this.props;
    P.textContent = '';
    if (!it) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = this.text.items.length ? 'Select a text item to edit it.' : 'Add a title, credits or text. They play on top of every visual mode.';
      P.appendChild(hint);
      return;
    }
    const ap = this.app.assetPanel;            // reuse its small DOM helpers
    const up = (patch) => this.text.update(it.id, patch);

    // Words
    const g1 = ap.group(it.kind === 'credits' ? 'Credits (one line each; "# " = heading)' : it.kind === 'title' ? 'Title (line 1 = title, next lines = subtitle)' : 'Text');
    const ta = document.createElement('textarea');
    ta.id = 'textContent';
    ta.rows = it.kind === 'credits' ? 8 : 3;
    ta.value = it.content;
    ta.addEventListener('input', () => { it.content = ta.value; this.text.emit('tick'); this.refreshRow(it); });
    ta.addEventListener('change', () => this.text.update(it.id, { content: ta.value }));
    g1.appendChild(ta);
    P.appendChild(g1);

    // Timing / lock
    const g2 = ap.group('Lock & timing');
    const anchor = this.segment([['start', 'Start'], ['time', 'At time'], ['end', 'End']], it.anchor, (v) => up({ anchor: v, firedAt: null }), 'textAnchor');
    g2.appendChild(anchor);
    if (it.anchor !== 'end') {
      const start = this.num(it.start, 0, 0.1, (v) => up({ start: v }), 'textStart');
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'btn';
      use.textContent = 'Playhead';
      use.title = 'Start at the current playhead';
      use.addEventListener('click', () => up({ start: +this.app.masterTime().toFixed(1), anchor: it.anchor === 'start' && this.app.masterTime() > 0 ? 'time' : it.anchor }));
      g2.appendChild(this.row('Starts (s)', start, use));
    }
    g2.appendChild(this.row('Length (s)', this.num(it.duration, 0.5, 0.5, (v) => up({ duration: v }), 'textDuration')));
    const when = document.createElement('p');
    when.className = 'hint';
    when.textContent = `On screen: ${this.timeText(it)}`;
    g2.appendChild(when);
    if (!this.app.isTrackMode()) {
      const fire = document.createElement('button');
      fire.type = 'button';
      fire.className = 'btn btn-block';
      fire.id = 'textShowNow';
      fire.textContent = 'Show now';
      fire.title = 'Live mode: play this item from now';
      fire.addEventListener('click', () => this.text.fire(it.id));
      g2.appendChild(fire);
    }
    P.appendChild(g2);

    // Look
    const g3 = ap.group('Look');
    g3.appendChild(this.row('Font', ap.select([['display', 'Display (Boldonse)'], ['sans', 'Sans'], ['mono', 'Mono'], ['serif', 'Serif']], it.style.font, (v) => up({ style: { font: v } }), 'textFont')));
    g3.appendChild(this.row('Size', this.segment([['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], it.style.size, (v) => up({ style: { size: v } }), 'textSize')));
    const color = document.createElement('input');
    color.type = 'color';
    color.id = 'textColor';
    color.value = it.style.color;
    color.addEventListener('input', () => { it.style.color = color.value; });
    color.addEventListener('change', () => up({ style: { color: color.value } }));
    g3.appendChild(this.row('Colour', color));
    g3.appendChild(this.row('Align', this.segment([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], it.style.align, (v) => up({ style: { align: v } }), 'textAlign')));
    if (it.anim !== 'roll') {
      const positions = [['top', 'Top'], ['center', 'Centre'], ['lower', 'Lower third'], ['bottom', 'Bottom']];
      if (it.kind === 'text' || it.style.position === 'free') positions.push(['free', 'Free (drag on screen)']);
      g3.appendChild(this.row('Position', ap.select(positions, it.style.position, (v) => up({ style: v === 'free' && it.style.x == null ? { position: v, x: 0.5, y: 0.5 } : { position: v } }), 'textPosition')));
      if (it.kind === 'text') {
        const tip = document.createElement('p');
        tip.className = 'hint';
        tip.textContent = 'Drag the dashed box on screen to place this text anywhere.';
        g3.appendChild(tip);
      }
    }
    g3.appendChild(this.row('Backing', this.segment([['none', 'None'], ['shadow', 'Shadow'], ['plate', 'Plate']], it.style.plate, (v) => up({ style: { plate: v } }), 'textPlate')));
    const anims = it.kind === 'credits' ? [['roll', 'Roll'], ['fade', 'Fade'], ['none', 'None']] : [['fade', 'Fade'], ['rise', 'Rise'], ['none', 'None']];
    g3.appendChild(this.row('Animation', ap.select(anims, it.anim, (v) => up({ anim: v }), 'textAnim')));
    P.appendChild(g3);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-block';
    del.id = 'textDelete';
    del.textContent = 'Delete text';
    del.addEventListener('click', () => this.text.remove(it.id));
    P.appendChild(del);
  }

  refreshRow(it) {
    const row = Array.from(this.list.children).find(r => r.classList.contains('selected'));
    if (row) row.querySelector('.asset-name').textContent = this.label(it);
  }

  // Plain rows (not <label>s), so clicking a caption never presses a button.
  row(label, ...controls) {
    const r = document.createElement('div');
    r.className = 'prop-row' + (controls.length > 1 ? ' prop-row-3' : '');
    const l = document.createElement('span');
    l.className = 'prop-row-label';
    l.textContent = label;
    r.append(l, ...controls);
    return r;
  }

  segment(options, value, onPick, id) {
    const seg = document.createElement('div');
    seg.className = 'seg seg-btns';
    if (id) seg.id = id;
    options.forEach(([v, l]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = v;
      b.textContent = l;
      b.classList.toggle('on', v === value);
      b.addEventListener('click', () => onPick(v));
      seg.appendChild(b);
    });
    return seg;
  }

  num(value, min, step, onChange, id) {
    const n = document.createElement('input');
    n.type = 'number';
    n.min = min;
    n.step = step;
    n.value = value;
    if (id) n.id = id;
    n.addEventListener('change', () => onChange(Math.max(min, parseFloat(n.value) || min)));
    return n;
  }
}
