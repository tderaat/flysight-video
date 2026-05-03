
function renderAltGraphWidget(ctx, contentRect, widget, dataIdx, units, scale, opacity) {
  const fd = state.currentFlightData;
  const config = widget.config;
  const effectiveScale = widget.widgetScale || 1;
  const w = contentRect.width * 0.3 * effectiveScale;
  const h = contentRect.height * 0.2 * effectiveScale;
  const cx = widget.x * contentRect.width;
  const cy = widget.y * contentRect.height;
  const x = cx - w / 2;
  const y = cy - h / 2;

  widget._bounds = { x, y, w, h };

  ctx.save();
  ctx.globalAlpha = opacity !== undefined ? opacity : 1;

  if (config.showBackground) {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, h * 0.06);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, w, h);
    }
  }

  if (!fd || !fd.times || fd.times.length < 2) {
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.3);
    ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.1, x + w * 0.5, y + h * 0.5);
    ctx.quadraticCurveTo(x + w * 0.7, y + h * 0.8, x + w, y + h * 0.9);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const times = fd.times;
  const alts = fd.altitudes;
  const minT = times[0], maxT = times[times.length - 1];
  const minAlt = Math.min(...alts), maxAlt = Math.max(...alts);
  const tRange = maxT - minT || 1;
  const altRange = maxAlt - minAlt || 1;
  const pad = 4;

  function tx(t) { return x + pad + (t - minT) / tRange * (w - pad * 2); }
  function ty(a) { return y + h - pad - (a - minAlt) / altRange * (h - pad * 2); }

  if (config.showMeasuringZone && fd.perfWindowStartTime !== null && fd.perfWindowEndTime !== null) {
    const zx1 = tx(fd.perfWindowStartTime);
    const zx2 = tx(fd.perfWindowEndTime);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.12)';
    ctx.fillRect(zx1, y, zx2 - zx1, h);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(zx1, y); ctx.lineTo(zx1, y + h);
    ctx.moveTo(zx2, y); ctx.lineTo(zx2, y + h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (config.showScoringZone && fd.best3sStart !== null && fd.best3sEnd !== null) {
    const sx1 = tx(fd.best3sStart);
    const sx2 = tx(fd.best3sEnd);
    ctx.fillStyle = 'rgba(74, 222, 128, 0.15)';
    ctx.fillRect(sx1, y, sx2 - sx1, h);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx1, y); ctx.lineTo(sx1, y + h);
    ctx.moveTo(sx2, y); ctx.lineTo(sx2, y + h);
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < times.length; i++) {
    const px = tx(times[i]);
    const py = ty(alts[i]);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5 * effectiveScale;
  ctx.stroke();

  ctx.lineTo(tx(times[times.length - 1]), y + h - pad);
  ctx.lineTo(tx(times[0]), y + h - pad);
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
  ctx.fill();

  if (dataIdx >= 0 && dataIdx < times.length) {
    const mx = tx(times[dataIdx]);
    const my = ty(alts[dataIdx]);
    ctx.beginPath();
    ctx.arc(mx, my, 3 * effectiveScale, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();

    ctx.strokeStyle = 'rgba(248, 250, 252, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, y);
    ctx.lineTo(mx, y + h);
    ctx.stroke();
  }

  if (config.showLabel) {
    const labelFontSize = h * 0.12;
    ctx.font = '600 ' + labelFontSize + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('ALTITUDE', x + pad, y + h - pad);
  }

  ctx.restore();
}

function renderAltGraphPreviewCard(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width - 16;
  const h = canvas.height - 16;
  const x = 8, y = 8;

  ctx.beginPath();
  const pts = [0.2, 0.15, 0.1, 0.12, 0.15, 0.3, 0.5, 0.65, 0.8, 0.88, 0.92];
  for (let i = 0; i < pts.length; i++) {
    const px = x + (i / (pts.length - 1)) * w;
    const py = y + pts[i] * h;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
  ctx.fill();

  ctx.fillStyle = 'rgba(250, 204, 21, 0.15)';
  ctx.fillRect(x + w * 0.25, y, w * 0.45, h);
}

function buildAltGraphConfigPanel(widget, drawOverlayPreview) {
  const wrap = document.createElement('div');
  const checks = document.createElement('div');
  checks.className = 'widget-config-checks';
  [
    { key: 'showLabel', label: 'Show label' },
    { key: 'showBackground', label: 'Show background' },
    { key: 'showMeasuringZone', label: 'Show measuring zone' },
    { key: 'showScoringZone', label: 'Show scoring zone' },
    { key: 'fadeIn', label: 'Fade in before exit' },
  ].forEach(({ key, label }) => {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!widget.config[key];
    cb.addEventListener('change', () => {
      widget.config[key] = cb.checked;
      drawOverlayPreview();
      state.scheduleSaveWidgetLayout();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + label));
    checks.appendChild(lbl);
  });
  wrap.appendChild(checks);
  return wrap;
}
