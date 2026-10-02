// 03 Assets (v2.1, D-44): one bin for images and video, the asset list,
// and the selected asset's properties, shown where the fixed
// Bass/Mid/High upload slots used to be. Options change with the item.
//
// Media Layers are an option on an asset ("Use as: Media Layer"). The
// layer engine is unchanged: ClipEngine.setAssetLayer() calls
// DJVisualizer.loadLayerMedia()/clearLayerMedia(), and the layer controls
// below edit visualizer.layers[slot] through its existing methods. The
// controls keep their old IDs (layerEnabled/Justify/Stack-<slot>) so the
// visualizer's auto-justify and stack-swap can still update them.
class AssetPanel {
  constructor(app) {
    this.app = app;
    this.engine = app.clipEngine;
    this.viz = app.visualizer;
  }

  init() {
    this.list = document.getElementById('assetList');
    this.props = document.getElementById('assetProps');
    const input = document.getElementById('assetUpload');
    const drop = document.getElementById('assetDrop');

    input.addEventListener('change', (e) => {
      this.addAndSelect(e.target.files);
      e.target.value = '';
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drag-over');
      this.addAndSelect(e.dataTransfer.files);
    });

    this.engine.on((type) => {
      if (type === 'clips' || type === 'select') this.render();
    });
    // ON AIR / decode state change without an event; refresh just the
    // status rows a few times a second.
    setInterval(() => this.refreshStatus(), 250);
    this.render();
  }

  addAndSelect(files) {
    const before = this.engine.assets.length;
    this.engine.addFiles(files);
    const added = this.engine.assets[before];
    if (added) this.engine.select(added.id);
  }

  render() {
    this.renderList();
    this.renderProps(this.engine.clipById(this.engine.selectedId));
  }

  renderList() {
    const sel = this.engine.selectedId;
    this.list.textContent = '';
    this.engine.assets.forEach(a => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'asset-row' + (a.id === sel ? ' selected' : '') + (a.error ? ' bin-error' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(a.id === sel));
      row.dataset.id = a.id;

      const thumb = document.createElement(a.thumb ? 'img' : 'span');
      thumb.className = 'asset-thumb';
      if (a.thumb) { thumb.src = a.thumb.toDataURL('image/jpeg', 0.7); thumb.alt = ''; }

      const name = document.createElement('span');
      name.className = 'asset-name';
      name.textContent = a.name;
      name.title = a.name;

      const tags = document.createElement('span');
      tags.className = 'asset-tags';
      tags.textContent = this.roleTags(a);

      row.append(thumb, name, tags);
      row.addEventListener('click', () => this.engine.select(a.id));
      this.list.appendChild(row);
    });
  }

  roleTags(a) {
    const t = [a.kind === 'image' ? 'IMG' : 'VID'];
    if (a.asClip) t.push(`#${a.importance}`);
    if (a.layer) t.push(a.layer.slice(0, 3).toUpperCase());
    if (this.engine.settings.storyMode && a.story !== 'none') t.push(({ hook: 'HOOK', result: 'RES', cta: 'CTA' })[a.story]);
    return t.join(' · ');
  }

  // ---- properties ------------------------------------------------------

  renderProps(a) {
    const P = this.props;
    P.textContent = '';
    if (!a) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = this.engine.assets.length
        ? 'Select an asset to see its options.'
        : 'Add images or video. Each one can be an auto-edit clip, a Media Layer, or both.';
      P.appendChild(hint);
      return;
    }

    const head = document.createElement('div');
    head.className = 'props-head';
    head.innerHTML = `<span class="kind-badge">${a.kind === 'image' ? 'Image' : 'Video'}</span>`;
    const nm = document.createElement('span');
    nm.className = 'props-name';
    nm.textContent = a.name;
    nm.title = a.name;
    head.appendChild(nm);
    P.appendChild(head);

    // Use as: two independent switches (Q16)
    const useAs = this.group('Use as');
    const clipBox = this.check('Auto-edit clip', a.asClip, (on) => this.engine.setAssetAsClip(a.id, on));
    clipBox.id = 'propAsClip';
    useAs.appendChild(clipBox.parentElement);
    const layerSel = this.select([['', 'No Media Layer'], ['background', 'Layer: Background'], ['bass', 'Layer: Bass'], ['mid', 'Layer: Mid'], ['high', 'Layer: High']],
      a.layer || '', (v) => this.engine.setAssetLayer(a.id, v || null));
    layerSel.id = 'propLayer';
    layerSel.setAttribute('aria-label', 'Media Layer slot');
    useAs.appendChild(layerSel);
    if (a.layer && a.layer !== 'background') useAs.appendChild(this.layerControls(a.layer));
    P.appendChild(useAs);

    // Story Position (Story Mode only, D-33). A story asset has a fixed
    // place and plays once, so Pace and Importance don't apply to it.
    const storyMode = this.engine.settings.storyMode;
    const isStory = storyMode && a.story !== 'none';
    if (storyMode) {
      const sg = this.group('Story');
      sg.appendChild(this.row('Position', this.select(
        [['none', 'None'], ['hook', 'Hook'], ['result', 'Result / Climax'], ['cta', 'CTA']], a.story,
        (v) => this.engine.setClipStory(a.id, v), 'propStory',
        'Hook = beginning, Result / Climax = after the automated content, CTA = ending. Each plays once.')));
      if (isStory && a.kind === 'image') {
        const hold = document.createElement('input');
        hold.type = 'number';
        hold.id = 'propStoryHold';
        hold.min = 0.5;
        hold.step = 0.5;
        hold.value = a.storyHold;
        hold.addEventListener('change', () => this.engine.setStoryHold(a.id, parseFloat(hold.value) || 3));
        sg.appendChild(this.row('Holds (s)', hold));
      } else if (isStory) {
        const note = document.createElement('p');
        note.className = 'hint';
        note.textContent = 'Plays its full length once, with its own sound.';
        sg.appendChild(note);
      }
      P.appendChild(sg);
    }

    // Clip fields (only when used as an auto-edit clip, and not a story asset)
    if (a.asClip && !isStory) {
      const clipG = this.group('Clip');
      clipG.appendChild(this.row('Band', this.select(
        [['any', 'Any band'], ['bass', 'Bass'], ['mid', 'Mid'], ['high', 'High']], a.band,
        (v) => this.engine.setClipBand(a.id, v), 'propBand',
        'Band pool (used when clip order = By dominant band)')));
      clipG.appendChild(this.row('Pace', this.select(
        [['global', 'Global'], ...Object.entries(MusicalTime.AUTO_PACES).map(([k, v]) => [k, v.label])], a.pace,
        (v) => this.engine.setClipPace(a.id, v), 'propPace',
        'How long this clip holds on screen. Global follows the Auto-Editor panel.')));
      const imp = document.createElement('input');
      imp.type = 'number';
      imp.id = 'propImportance';
      imp.min = 1;
      imp.max = this.engine.clips.length;
      imp.value = a.importance;
      imp.title = 'Place in the Action Editor stack (1 = top, picked most)';
      imp.addEventListener('change', () => this.engine.setClipImportance(a.id, parseInt(imp.value, 10) || 1));
      clipG.appendChild(this.row('Importance', imp));
      P.appendChild(clipG);
    }

    // Per-asset status (D-43)
    const st = this.group('Status');
    st.classList.add('asset-status');
    st.id = 'assetStatus';
    P.appendChild(st);
    this.fillStatus(a, st);

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn btn-block';
    rm.id = 'propRemove';
    rm.textContent = 'Remove asset';
    rm.addEventListener('click', () => this.engine.removeAsset(a.id));
    P.appendChild(rm);
  }

  // Enabled / justify / stack for a bass/mid/high layer, bound to the
  // visualizer exactly as the old sidebar controls were.
  layerControls(slot) {
    const L = this.viz.layers[slot];
    const wrap = document.createElement('div');
    wrap.className = 'layer-controls-group';
    const en = this.check('Layer enabled', L.enabled, (on) => {
      L.enabled = on;
      this.viz.autoAssignJustify();
    });
    en.id = `layerEnabled-${slot}`;
    wrap.appendChild(en.parentElement);
    const row = document.createElement('div');
    row.className = 'layer-controls';
    const j = this.select([['left', 'Left'], ['center', 'Center'], ['right', 'Right']], L.justify,
      (v) => { L.justify = v; }, `layerJustify-${slot}`, 'Justify');
    const s = this.select([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], L.stack,
      (v) => this.viz.assignStackPosition(slot, v), `layerStack-${slot}`, 'Stack');
    j.setAttribute('aria-label', 'Layer justify');
    s.setAttribute('aria-label', 'Layer stack');
    row.append(j, s);
    wrap.appendChild(row);
    return wrap;
  }

  fillStatus(a, el) {
    el.querySelectorAll('.status-item').forEach(n => n.remove());
    const now = this.engine.nowShowing();
    const onAir = !!(now && now.clip === a);
    const roles = [];
    if (this.engine.settings.storyMode && a.story !== 'none') roles.push(`Story ${a.story}`);
    else if (a.asClip) roles.push(`Clip #${a.importance}`);
    if (a.layer) roles.push(`Layer ${a.layer}`);
    const rows = [
      ['Type', a.kind === 'image' ? 'Image' : 'Video'],
      ['Length', a.kind === 'image' ? 'Still' : (a.duration ? fmtTime(a.duration, true) : '…')],
      ['Size', a.width ? `${a.width}×${a.height}` : '…'],
      ['Decode', a.error ? 'ERR' : a.ready ? 'OK' : 'Loading…'],
      ['On air', onAir ? 'Yes' : 'No'],
      ['Role', roles.join(' · ') || 'Unused'],
    ];
    rows.forEach(([k, v]) => {
      const r = document.createElement('div');
      r.className = 'status-item' + (k === 'On air' && onAir ? ' on-air' : '') + (k === 'Decode' && a.error ? ' is-err' : '');
      r.innerHTML = `<span class="status-label">${k}</span>`;
      const val = document.createElement('span');
      val.textContent = v;
      if (k === 'Decode' && a.error) val.title = `${a.error}. Try Chrome/Edge, or convert to WebM (VP9) or H.264 MP4.`;
      r.appendChild(val);
      el.appendChild(r);
    });
  }

  refreshStatus() {
    const el = document.getElementById('assetStatus');
    const a = this.engine.clipById(this.engine.selectedId);
    if (el && a) this.fillStatus(a, el);
  }

  // ---- small DOM helpers -----------------------------------------------

  group(title) {
    const g = document.createElement('div');
    g.className = 'prop-group';
    const t = document.createElement('div');
    t.className = 'prop-label';
    t.textContent = title;
    g.appendChild(t);
    return g;
  }

  row(label, control) {
    const r = document.createElement('label');
    r.className = 'prop-row';
    const l = document.createElement('span');
    l.className = 'prop-row-label';
    l.textContent = label;
    r.append(l, control);
    return r;
  }

  select(options, value, onChange, id, title) {
    const s = document.createElement('select');
    options.forEach(([v, l]) => s.add(new Option(l, v)));
    s.value = value;
    if (id) s.id = id;
    if (title) s.title = title;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  check(label, checked, onChange) {
    const l = document.createElement('label');
    l.className = 'prop-check';
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = checked;
    c.addEventListener('change', () => onChange(c.checked));
    const s = document.createElement('span');
    s.textContent = label;
    l.append(c, s);
    return c;
  }
}
