// 03 Output › Export video (D-61): settings, what will be exported,
// progress with time left, and cancel. The work is done by OfflineRenderer.
class ExportPanel {
  constructor(app) {
    this.app = app;
  }

  init() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      size: $('exportSize'), range: $('exportRange'), fps: $('exportFps'), quality: $('exportQuality'),
      summary: $('exportSummary'), warnings: $('exportWarnings'), start: $('exportStart'),
      progress: $('exportProgress'), bar: $('exportBar'), status: $('exportStatus'), cancel: $('exportCancel'),
      result: $('exportResult'),
    };
    if (!this.el.start) return;
    Object.entries(OfflineRenderer.SIZES).forEach(([k, v]) => this.el.size.add(new Option(v.label, k)));
    this.el.size.value = '1080p';
    this.el.start.addEventListener('click', () => this.run());
    this.el.cancel.addEventListener('click', () => this.app.renderer.cancel());
    if (!OfflineRenderer.supported()) {
      this.el.start.disabled = true;
      this.el.summary.textContent = 'This browser cannot encode video. Use Chrome or Edge.';
      return;
    }
    // Keep the summary current while 03 Output is open.
    setInterval(() => { if (!this.app.renderer.busy && this.app.sidebar.isOpen('output')) this.refresh(); }, 2000);
    if (this.app.sidebar) this.app.sidebar.on(() => { if (this.app.sidebar.isOpen('output')) this.refresh(); });
    // The export size follows the display size picked in the header (D-63).
    if (this.app.display) this.app.display.on((key) => { if (OfflineRenderer.SIZES[key]) this.el.size.value = key; });
    this.refresh();
  }

  refresh() {
    const plan = this.app.renderer.plan();
    this.plan = plan;
    const parts = [];
    if (plan.duration > 0) {
      parts.push(`${fmtTime(plan.duration, false)} long`);
      parts.push(`${Math.round((plan.recorded / plan.duration) * 100)}% recorded`);
      if (plan.played && (plan.played.start > 0.5 || plan.played.end < plan.duration - 0.5)) parts.push(`played ${fmtTime(plan.played.start, false)}–${fmtTime(plan.played.end, false)}`);
      if (plan.cuts) parts.push(`${plan.cuts} cuts`);
      if (this.app.text.items.length) parts.push(`${this.app.text.items.length} text`);
    }
    this.el.summary.textContent = parts.length ? parts.join(' · ') : 'Nothing to export yet.';
    this.el.warnings.textContent = '';
    plan.warnings.forEach(w => {
      const li = document.createElement('li');
      li.textContent = w;
      this.el.warnings.appendChild(li);
    });
    this.el.start.disabled = !plan.ok || this.app.renderer.busy;
  }

  async run() {
    const el = this.el;
    el.result.hidden = true;
    el.result.textContent = '';
    el.start.disabled = true;
    el.progress.hidden = false;
    el.bar.style.width = '0%';
    el.status.textContent = MediaLibrary.canUse('showSaveFilePicker') ? 'Choose where to save…' : 'Preparing…';
    try {
      const res = await this.app.renderer.export({
        size: el.size.value, range: el.range.value, fps: parseInt(el.fps.value, 10), quality: el.quality.value, name: this.app.project.name,
      }, (p) => {
        el.bar.style.width = `${Math.round((p.done / p.total) * 100)}%`;
        if (p.stage === 'Rendering') {
          el.status.textContent = `Rendering ${Math.round((p.done / p.total) * 100)}% · ${p.speed.toFixed(1)}× real time · ${fmtTime(p.eta, false)} left`;
        } else {
          el.status.textContent = `${p.stage}…`;
        }
      });
      el.result.hidden = false;
      const msg = `Saved ${res.name} · ${res.width}×${res.height} · ${fmtTime(res.duration, false)} in ${fmtTime(res.seconds, false)} (${res.speed.toFixed(1)}× real time)`;
      if (res.blob) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(res.blob);
        a.download = res.name;
        // No save dialog in this browser (e.g. Firefox): download it now; the link stays for another copy.
        document.body.appendChild(a); a.click(); a.remove();
        a.textContent = `Download ${res.name}`;
        el.result.append(`${res.width}×${res.height} · ${fmtTime(res.duration, false)} · `, a);
      } else {
        el.result.textContent = msg;
      }
      if (this.app.notify) this.app.notify(`Export finished: ${res.name}`);
    } catch (e) {
      el.result.hidden = false;
      if (e && e.name === 'AbortError') el.result.textContent = this.app.renderer.cancelled ? 'Export cancelled.' : 'Export not started.';
      else { el.result.textContent = `Export failed: ${e && e.message || e}`; console.error(e); }
    } finally {
      el.progress.hidden = true;
      this.refresh();
    }
  }
}
